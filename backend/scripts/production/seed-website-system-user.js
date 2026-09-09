'use strict';

/**
 * Phase 45B — one-time production D1 initialization: creates exactly one
 * dedicated service APPLICATION_USER account that
 * src/worker/routes/public-inquiries.ts uses as `inquiries.created_by`
 * (NOT NULL, FK -> users(id)) for every unauthenticated public inquiry
 * submission. Modeled directly on
 * scripts/production/seed-initial-master-user.js — same idempotency
 * checks, same safety gate, same never-print-the-secret discipline —
 * because this is the same class of problem (a privileged account with
 * no registration endpoint, needing exactly one real D1 write, done
 * once, deliberately, outside the normal API).
 *
 * Facts this script relies on, verified by reading the real
 * implementation before writing this (not assumed):
 *   - users table CHECK constraint (migrations/0001_initial_schema.sql):
 *     an APPLICATION_USER row MUST have user_id NOT NULL, password_hash
 *     NOT NULL, role NOT NULL (ADMIN or EMPLOYEE).
 *   - EMPLOYEE, not ADMIN: routes/public-inquiries.ts's header comment
 *     explains why — the ADMIN-only Group A/B creation rule and the
 *     ADMIN-only inquiry-verification-reaper sweep both key off the
 *     creator's *current* role, and an EMPLOYEE actor is structurally
 *     invisible to both.
 *   - There is no API endpoint that can create an APPLICATION_USER with
 *     an arbitrary role for this purpose outside the normal staff-
 *     management flow (POST /users is itself ADMIN-authenticated) — a
 *     direct D1 write is the correct mechanism here, same reasoning as
 *     the MASTER-user script.
 *   - This account is never meant to log in — nobody is ever given its
 *     password. A cryptographically random password is generated and
 *     hashed only to satisfy the NOT NULL constraint; it is never
 *     printed, logged, or stored anywhere outside the hash itself.
 *   - created_by/updated_by: NULL for this bootstrap row, same
 *     reasoning as the MASTER seed (it is a root of the created_by
 *     chain for the rows it will itself create, not created by anyone).
 *   - No audit_logs row is written, same reasoning as the MASTER seed:
 *     audit records are written by the application's own create-user
 *     code path (users.ts), which this bootstrap deliberately does not
 *     go through.
 *
 * Safety: gated by the same scripts/production/lib/safety.js used by
 * every other production-writing script in this repo. --remote and
 * --config wrangler.production.jsonc are hardcoded.
 *
 * Never prints: the plaintext password, the bcrypt hash, or any secret.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { assertProductionSeedAllowed, PRODUCTION_D1_DATABASE_NAME, PRODUCTION_WRANGLER_CONFIG } = require('./lib/safety');
const { runWranglerCapture } = require('../migration/lib/run-wrangler');
const { sqlLiteral, buildInsert } = require('../migration/lib/sql-format');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const TMP_DIR = path.join(__dirname, 'tmp');
const BCRYPT_COST = 12; // matches src/worker/utils/password.ts exactly

const TARGET_USER_ID = 'SYSTEM-WEBSITE';
const TARGET_NAME = 'Website System';
const TARGET_ROLE = 'EMPLOYEE';

function d1Query(sql) {
  const out = runWranglerCapture(BACKEND_DIR, [
    'd1', 'execute', PRODUCTION_D1_DATABASE_NAME, '--remote', '--config', PRODUCTION_WRANGLER_CONFIG, '--json', '--command', sql,
  ]);
  return JSON.parse(out)[0].results;
}

function d1Exec(sql) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `seed-website-system-${Date.now()}.sql`);
  fs.writeFileSync(filePath, sql, 'utf8');
  try {
    runWranglerCapture(BACKEND_DIR, [
      'd1', 'execute', PRODUCTION_D1_DATABASE_NAME, '--remote', '--config', PRODUCTION_WRANGLER_CONFIG, '--json', '--file', filePath,
    ]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

async function main() {
  assertProductionSeedAllowed('seed-website-system-user.js');

  // --- 1. Verify Worker production config actually points at the D1 we're about to write to.
  const configPath = path.join(BACKEND_DIR, PRODUCTION_WRANGLER_CONFIG);
  const configText = fs.readFileSync(configPath, 'utf8');
  const nameMatch = configText.match(/"database_name"\s*:\s*"([^"]+)"/);
  if (!nameMatch || nameMatch[1] !== PRODUCTION_D1_DATABASE_NAME) {
    console.error(`[seed] Refusing to run: ${PRODUCTION_WRANGLER_CONFIG} does not declare database_name="${PRODUCTION_D1_DATABASE_NAME}" (found: ${nameMatch ? nameMatch[1] : 'none'}).`);
    process.exit(1);
  }
  console.log(`[seed] Verified: ${PRODUCTION_WRANGLER_CONFIG} binds DB -> "${nameMatch[1]}".`);

  // --- 2. Verify the D1 database identity itself.
  const d1List = JSON.parse(runWranglerCapture(BACKEND_DIR, ['d1', 'list', '--json']));
  const prodDb = d1List.find((db) => db.name === PRODUCTION_D1_DATABASE_NAME);
  if (!prodDb) {
    console.error(`[seed] Refusing to run: no D1 database named "${PRODUCTION_D1_DATABASE_NAME}" found in the account.`);
    process.exit(1);
  }
  console.log(`[seed] Verified: D1 database "${prodDb.name}" exists (uuid ${prodDb.uuid}).`);

  // --- 3. Verify schema exists.
  const tables = d1Query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';").map((r) => r.name).sort();
  const expected = ['attachments', 'audit_logs', 'follow_ups', 'inquiries', 'inquiry_assignments', 'notifications', 'properties', 'users'].sort();
  const missing = expected.filter((t) => !tables.includes(t));
  if (missing.length > 0) {
    console.error(`[seed] Refusing to run: missing expected table(s): ${missing.join(', ')}.`);
    process.exit(1);
  }
  console.log(`[seed] Verified: all 8 application tables exist (${tables.join(', ')}).`);

  // --- 4. Idempotency check: does the intended account already exist?
  const existingRows = d1Query(`SELECT id, user_id, user_type, role, name, status FROM users WHERE user_id = ${sqlLiteral(TARGET_USER_ID)};`);
  if (existingRows.length > 1) {
    console.error(`[seed] STOPPING: ${existingRows.length} rows already have user_id="${TARGET_USER_ID}" — expected at most 1. Investigate manually.`);
    process.exit(1);
  }
  if (existingRows.length === 1) {
    const existing = existingRows[0];
    const shapeMatches =
      existing.user_type === 'APPLICATION_USER' && existing.role === TARGET_ROLE && existing.status === 'ACTIVE';
    if (shapeMatches) {
      console.log('[seed] IDEMPOTENT NO-OP: intended service account already exists. Not creating a duplicate.');
      console.log(`[seed] Existing account: id=${existing.id}, userId=${existing.user_id}, role=${existing.role}, status=${existing.status}.`);
      return;
    }
    console.error('[seed] STOPPING: a row with this user_id already exists but differs from the intended account — not overwriting.');
    console.error('[seed] Existing (safe fields only):', JSON.stringify({
      id: existing.id, user_id: existing.user_id, user_type: existing.user_type, role: existing.role, status: existing.status,
    }));
    console.error('[seed] Intended:', JSON.stringify({ user_id: TARGET_USER_ID, user_type: 'APPLICATION_USER', role: TARGET_ROLE, status: 'ACTIVE' }));
    process.exit(1);
  }

  // --- 5. Current users row count (for the before/after sanity log).
  const [{ count: usersCountBefore }] = d1Query('SELECT COUNT(*) AS count FROM users;');
  console.log(`[seed] users table row count before: ${usersCountBefore}`);

  // --- 6. Create. Password is random and never surfaced anywhere — this
  // account is never intended to log in; the hash exists only to satisfy
  // the NOT NULL constraint.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const randomPassword = crypto.randomBytes(32).toString('base64');
  const passwordHash = await bcrypt.hash(randomPassword, BCRYPT_COST);

  const columns = [
    'id', 'user_id', 'user_type', 'role', 'name', 'email', 'mobile', 'alternate_mobile',
    'address', 'city', 'state', 'pincode', 'password_hash', 'status', 'last_login_at',
    'created_at', 'updated_at', 'created_by', 'updated_by',
  ];
  const row = {
    id, user_id: TARGET_USER_ID, user_type: 'APPLICATION_USER', role: TARGET_ROLE, name: TARGET_NAME, email: null,
    mobile: null, alternate_mobile: null, address: null, city: null, state: null, pincode: null,
    password_hash: passwordHash, status: 'ACTIVE', last_login_at: null,
    created_at: now, updated_at: now, created_by: null, updated_by: null,
  };
  const insertSql = buildInsert('users', columns, row);

  console.log(`[seed] Creating service account: userId=${TARGET_USER_ID}, role=${TARGET_ROLE}, id=${id}.`);
  d1Exec(insertSql);

  const [{ count: usersCountAfter }] = d1Query('SELECT COUNT(*) AS count FROM users;');
  console.log(`[seed] users table row count after: ${usersCountAfter}`);
  console.log('[seed] Done. Service account created successfully. Password/hash were never printed.');
}

main().catch((err) => {
  console.error('[seed] FAILED:', err.message || err);
  process.exitCode = 1;
});
