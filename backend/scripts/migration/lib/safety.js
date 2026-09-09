'use strict';

/**
 * Phase 10 — shared safety gate for every migration script that reads
 * from PostgreSQL and/or writes to D1. Two independent checks, both
 * required:
 *
 *   1. Explicit opt-in: ALLOW_DATA_MIGRATION=true must be set in the
 *      environment. Nothing here runs "by accident" from a bare
 *      `node export-postgres.js`.
 *   2. Production-target detection: DATABASE_URL, NODE_ENV, and D1_ENV
 *      are all inspected for anything that looks like a production
 *      target (hostname other than localhost/127.0.0.1, or the literal
 *      words "prod"/"production" anywhere in the relevant values). If
 *      found, the script refuses unconditionally — the opt-in flag
 *      above does NOT override this; a real production migration is
 *      explicitly out of scope for this phase and must never be
 *      reachable through this tooling.
 *
 * D1 writes are additionally hardcoded to `--local` in import-d1.js
 * itself (see that file) — there is no code path in this tooling that
 * can pass `--remote` to wrangler, by construction, not just by
 * environment-variable convention.
 */

function assertMigrationAllowed(scriptName) {
  if (process.env.ALLOW_DATA_MIGRATION !== 'true') {
    console.error(
      `[safety] Refusing to run ${scriptName}: set ALLOW_DATA_MIGRATION=true to run migration tooling explicitly. ` +
        'This is a deliberate opt-in gate — see scripts/migration/README.md.',
    );
    process.exit(1);
  }

  const suspects = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['NODE_ENV', process.env.NODE_ENV],
    ['D1_ENV', process.env.D1_ENV],
  ];

  for (const [name, value] of suspects) {
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower.includes('prod')) {
      console.error(
        `[safety] Refusing to run ${scriptName}: ${name} contains "prod" (value pattern suggests a production target). ` +
          'This tooling only supports local/test databases. Production migration is explicitly out of scope for Phase 10.',
      );
      process.exit(1);
    }
  }

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    let host;
    try {
      host = new URL(dbUrl).hostname;
    } catch {
      console.error(`[safety] Refusing to run ${scriptName}: DATABASE_URL could not be parsed as a URL.`);
      process.exit(1);
    }
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocal) {
      console.error(
        `[safety] Refusing to run ${scriptName}: DATABASE_URL host "${host}" is not localhost/127.0.0.1. ` +
          'Only a local PostgreSQL instance is permitted for this tooling.',
      );
      process.exit(1);
    }
  }

  console.log(`[safety] OK — ${scriptName} running against a local, explicitly-opted-in target.`);
}

/**
 * Phase 13 — a SEPARATE, independent safety gate for scripts that
 * legitimately target real production PostgreSQL and/or production D1.
 * Deliberately not a variant/relaxation of assertMigrationAllowed() above
 * — that function's whole purpose is to refuse anything production-shaped,
 * and it is untouched by this addition. Local-only commands
 * (export-postgres.js, import-d1.js, reset-d1.js, verify-migration.js)
 * still go through assertMigrationAllowed() exactly as before and cannot
 * reach production through any flag or environment variable change here.
 *
 * Two independent factors are required, both distinct from
 * ALLOW_DATA_MIGRATION so a local run can never accidentally satisfy a
 * production check or vice versa:
 *   1. ALLOW_PRODUCTION_MIGRATION=true
 *   2. PRODUCTION_MIGRATION_CONFIRM=<exact phrase> — a boolean flag alone
 *      is one typo/copy-paste away from being set by habit; requiring an
 *      exact phrase forces a deliberate, one-off action.
 */
const PRODUCTION_CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_TARGETS_PRODUCTION';
const PRODUCTION_D1_DATABASE_NAME = 'aryan-landmark-production';
const PRODUCTION_WRANGLER_CONFIG = 'wrangler.production.jsonc';

function assertProductionModeOptIn(scriptName) {
  if (process.env.ALLOW_PRODUCTION_MIGRATION !== 'true') {
    console.error(
      `[safety] Refusing to run ${scriptName}: set ALLOW_PRODUCTION_MIGRATION=true. ` +
        'This is separate from, and does not imply or get satisfied by, ALLOW_DATA_MIGRATION.',
    );
    process.exit(1);
  }
  if (process.env.PRODUCTION_MIGRATION_CONFIRM !== PRODUCTION_CONFIRM_PHRASE) {
    console.error(
      `[safety] Refusing to run ${scriptName}: set PRODUCTION_MIGRATION_CONFIRM=${PRODUCTION_CONFIRM_PHRASE} ` +
        'as a second, independent, exact-phrase confirmation that this run is intentionally targeting production.',
    );
    process.exit(1);
  }
}

/** For scripts that read real production PostgreSQL (export only — never write). */
function assertProductionPostgresReadAllowed(scriptName) {
  assertProductionModeOptIn(scriptName);

  const dbUrl = process.env.PRODUCTION_DATABASE_URL;
  if (!dbUrl) {
    console.error(
      `[safety] Refusing to run ${scriptName}: PRODUCTION_DATABASE_URL is not set. ` +
        'This is deliberately a DIFFERENT variable from DATABASE_URL (which the local-only scripts read) ' +
        'so the two can never be confused, shared, or accidentally fall back on each other.',
    );
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(dbUrl);
  } catch {
    console.error(`[safety] Refusing to run ${scriptName}: PRODUCTION_DATABASE_URL could not be parsed as a URL.`);
    process.exit(1);
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (isLocal && process.env.PRODUCTION_MIGRATION_DRY_RUN !== 'true') {
    console.error(
      `[safety] Refusing to run ${scriptName}: PRODUCTION_DATABASE_URL host "${parsed.hostname}" looks local, ` +
        'not a real production host. If you are deliberately testing this tooling\'s mechanics against a local ' +
        'database, set PRODUCTION_MIGRATION_DRY_RUN=true and re-run — this is logged loudly as a dry run, never ' +
        'treated as a real production migration.',
    );
    process.exit(1);
  }

  const label = process.env.PRODUCTION_MIGRATION_DRY_RUN === 'true' ? 'DRY RUN (local target, tooling self-test only)' : 'REAL PRODUCTION';
  console.log(
    `[safety] ${label} — ${scriptName} will connect READ-ONLY to PostgreSQL host "${parsed.hostname}", ` +
      `port ${parsed.port || 5432}, database "${parsed.pathname.replace(/^\//, '')}". No write/mutation call exists in this script.`,
  );
}

/** For scripts that write to (import) or read (verify) real production D1. */
function assertProductionD1AccessAllowed(scriptName) {
  assertProductionModeOptIn(scriptName);

  if (process.env.D1_PRODUCTION_DATABASE_NAME !== PRODUCTION_D1_DATABASE_NAME) {
    console.error(
      `[safety] Refusing to run ${scriptName}: set D1_PRODUCTION_DATABASE_NAME=${PRODUCTION_D1_DATABASE_NAME} ` +
        'as an explicit, exact-match confirmation of the intended D1 target — independent of whatever ' +
        `${PRODUCTION_WRANGLER_CONFIG} currently contains, so a stale or edited config file can never silently ` +
        'redirect a production read/write.',
    );
    process.exit(1);
  }

  console.log(
    `[safety] REAL PRODUCTION — ${scriptName} will access D1 database "${PRODUCTION_D1_DATABASE_NAME}" ` +
      `via --config ${PRODUCTION_WRANGLER_CONFIG} --remote.`,
  );
}

module.exports = {
  assertMigrationAllowed,
  assertProductionPostgresReadAllowed,
  assertProductionD1AccessAllowed,
  PRODUCTION_CONFIRM_PHRASE,
  PRODUCTION_D1_DATABASE_NAME,
  PRODUCTION_WRANGLER_CONFIG,
};
