'use strict';

/**
 * Phase 13 (revised) — one-time production D1 initialization: creates
 * exactly one MASTER user so the fresh production database (no
 * PostgreSQL migration involved — see the Phase 13 report) has an
 * account that can actually log in.
 *
 * Schema/auth facts this script relies on, verified by reading the real
 * implementation before writing any of this (not assumed):
 *   - users table CHECK constraint (migrations/0001_initial_schema.sql):
 *     user_type='MASTER' rows MUST have user_id NOT NULL, password_hash
 *     NOT NULL, role NULL. There is no CHECK requiring mobile/address/etc.
 *   - POST /api/v1/master-auth/login (src/worker/routes/auth.ts) looks
 *     users up by `LOWER(email) = LOWER(?) AND user_type = 'MASTER'`,
 *     requires status = 'ACTIVE', and verifies password via
 *     src/worker/utils/password.ts's verifyPassword() — bcryptjs,
 *     identical to the algorithm used here.
 *   - There is no API endpoint that can create a MASTER user (confirmed
 *     by reading src/worker/routes/master-users.ts's POST /master/users:
 *     it hardcodes user_type='APPLICATION_USER' in its INSERT) — matching
 *     CLAUDE.md's documented statement that MASTER accounts are
 *     "manually provisioned (no registration endpoint anywhere)". A
 *     direct D1 write is therefore the only correct mechanism, not a
 *     shortcut around a real endpoint.
 *   - `user_id` convention: 'MASTER_001' — matches the real MASTER user
 *     already present in this project's local PostgreSQL test data
 *     (queried directly, read-only, before writing this script), not
 *     invented here.
 *   - created_by/updated_by: NULL for this bootstrap row — also matches
 *     that same real local MASTER user (it is the root of the
 *     created_by chain, referenced by other rows but referencing none).
 *   - No audit_logs row is written for this creation: audit records are
 *     written by the application's own create-user code path
 *     (master-users.ts's recordAudit() call), which this bootstrap
 *     deliberately does not go through (there is no such path for
 *     MASTER users) — so `audit_logs` staying at 0 rows is the correct,
 *     accurate reflection of what happened, not a gap.
 *
 * Safety: gated by scripts/production/lib/safety.js's
 * assertProductionSeedAllowed() (own env vars, independent from the
 * scripts/migration/ production gate — see that file's comment).
 * --remote and --config wrangler.production.jsonc are hardcoded, exactly
 * like every other production-writing script in this repo.
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

const TARGET_EMAIL = 'aryanlandmarksolutions@gmail.com';
const TARGET_USER_ID = 'MASTER_001';
const TARGET_NAME = 'Master Admin';

function d1Query(sql) {
  const out = runWranglerCapture(BACKEND_DIR, [
    'd1', 'execute', PRODUCTION_D1_DATABASE_NAME, '--remote', '--config', PRODUCTION_WRANGLER_CONFIG, '--json', '--command', sql,
  ]);
  return JSON.parse(out)[0].results;
}

function d1Exec(sql) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `seed-master-${Date.now()}.sql`);
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
  assertProductionSeedAllowed('seed-initial-master-user.js');

  const password = process.env.MASTER_SEED_PASSWORD;
  if (!password || password.length < 8) {
    console.error('[seed] Refusing to run: set MASTER_SEED_PASSWORD (>=8 chars) in the environment. Never hardcode it in this file.');
    process.exit(1);
  }

  // --- 1. Verify Worker production config actually points at the D1 we're about to write to.
  const configPath = path.join(BACKEND_DIR, PRODUCTION_WRANGLER_CONFIG);
  const configText = fs.readFileSync(configPath, 'utf8');
  const nameMatch = configText.match(/"database_name"\s*:\s*"([^"]+)"/);
  if (!nameMatch || nameMatch[1] !== PRODUCTION_D1_DATABASE_NAME) {
    console.error(`[seed] Refusing to run: ${PRODUCTION_WRANGLER_CONFIG} does not declare database_name="${PRODUCTION_D1_DATABASE_NAME}" (found: ${nameMatch ? nameMatch[1] : 'none'}).`);
    process.exit(1);
  }
  console.log(`[seed] Verified: ${PRODUCTION_WRANGLER_CONFIG} binds DB -> "${nameMatch[1]}".`);

  // --- 2. Verify the D1 database identity itself (not just the config file's claim).
  const d1List = JSON.parse(runWranglerCapture(BACKEND_DIR, ['d1', 'list', '--json']));
  const prodDb = d1List.find((db) => db.name === PRODUCTION_D1_DATABASE_NAME);
  if (!prodDb) {
    console.error(`[seed] Refusing to run: no D1 database named "${PRODUCTION_D1_DATABASE_NAME}" found in the account.`);
    process.exit(1);
  }
  console.log(`[seed] Verified: D1 database "${prodDb.name}" exists (uuid ${prodDb.uuid}).`);

  // --- 3. Verify schema exists (all 8 application tables).
  const tables = d1Query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations';").map((r) => r.name).sort();
  const expected = ['attachments', 'audit_logs', 'follow_ups', 'inquiries', 'inquiry_assignments', 'notifications', 'properties', 'users'].sort();
  const missing = expected.filter((t) => !tables.includes(t));
  if (missing.length > 0) {
    console.error(`[seed] Refusing to run: missing expected table(s): ${missing.join(', ')}.`);
    process.exit(1);
  }
  console.log(`[seed] Verified: all 8 application tables exist (${tables.join(', ')}).`);

  // --- 4. Current users row count.
  const [{ count: usersCountBefore }] = d1Query('SELECT COUNT(*) AS count FROM users;');
  console.log(`[seed] users table row count before: ${usersCountBefore}`);

  // --- 5. Idempotency check: does a MASTER user already exist?
  const masterRows = d1Query("SELECT id, user_id, user_type, role, name, email, status FROM users WHERE user_type = 'MASTER';");
  if (masterRows.length > 1) {
    console.error(`[seed] STOPPING: ${masterRows.length} MASTER users already exist — expected at most 1. Not creating another. Investigate manually.`);
    console.error('[seed] Existing MASTER user ids:', masterRows.map((r) => r.id).join(', '));
    process.exit(1);
  }
  if (masterRows.length === 1) {
    const existing = masterRows[0];
    const emailMatches = (existing.email || '').toLowerCase() === TARGET_EMAIL.toLowerCase();
    const shapeMatches = existing.user_id === TARGET_USER_ID && existing.role === null && existing.status === 'ACTIVE';
    if (emailMatches && shapeMatches) {
      console.log('[seed] IDEMPOTENT NO-OP: intended MASTER user already exists. Not creating a duplicate.');
      console.log(`[seed] Existing MASTER user: id=${existing.id}, userId=${existing.user_id}, email=${existing.email}, status=${existing.status}.`);
      return;
    }
    console.error('[seed] STOPPING: a MASTER user already exists but differs from the intended one — not overwriting.');
    console.error('[seed] Existing (safe fields only):', JSON.stringify({
      id: existing.id, user_id: existing.user_id, role: existing.role, name: existing.name, email: existing.email, status: existing.status,
    }));
    console.error('[seed] Intended:', JSON.stringify({ user_id: TARGET_USER_ID, email: TARGET_EMAIL, role: null, status: 'ACTIVE' }));
    process.exit(1);
  }

  // --- 6. Also check the target user_id isn't somehow already taken by a non-MASTER row (defense in depth).
  const userIdTaken = d1Query(`SELECT id, user_type FROM users WHERE user_id = ${sqlLiteral(TARGET_USER_ID)};`);
  if (userIdTaken.length > 0) {
    console.error(`[seed] STOPPING: user_id "${TARGET_USER_ID}" is already taken by a row of type ${userIdTaken[0].user_type} (id=${userIdTaken[0].id}). Not proceeding.`);
    process.exit(1);
  }
  const emailTaken = d1Query(`SELECT id, user_type FROM users WHERE LOWER(email) = LOWER(${sqlLiteral(TARGET_EMAIL)});`);
  if (emailTaken.length > 0) {
    console.error(`[seed] STOPPING: email is already taken by a row of type ${emailTaken[0].user_type} (id=${emailTaken[0].id}). Not proceeding.`);
    process.exit(1);
  }

  // --- 7. Create.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const columns = [
    'id', 'user_id', 'user_type', 'role', 'name', 'email', 'mobile', 'alternate_mobile',
    'address', 'city', 'state', 'pincode', 'password_hash', 'status', 'last_login_at',
    'created_at', 'updated_at', 'created_by', 'updated_by',
  ];
  const row = {
    id, user_id: TARGET_USER_ID, user_type: 'MASTER', role: null, name: TARGET_NAME, email: TARGET_EMAIL,
    mobile: null, alternate_mobile: null, address: null, city: null, state: null, pincode: null,
    password_hash: passwordHash, status: 'ACTIVE', last_login_at: null,
    created_at: now, updated_at: now, created_by: null, updated_by: null,
  };
  const insertSql = buildInsert('users', columns, row);

  console.log(`[seed] Creating MASTER user: userId=${TARGET_USER_ID}, email=${TARGET_EMAIL}, id=${id}.`);
  d1Exec(insertSql);

  const [{ count: usersCountAfter }] = d1Query('SELECT COUNT(*) AS count FROM users;');
  console.log(`[seed] users table row count after: ${usersCountAfter}`);
  console.log('[seed] Done. MASTER user created successfully. Password/hash were never printed.');
}

main().catch((err) => {
  console.error('[seed] FAILED:', err.message || err);
  process.exitCode = 1;
});
