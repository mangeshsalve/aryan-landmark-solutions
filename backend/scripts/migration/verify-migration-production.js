'use strict';

/**
 * Phase 13, Step 4 of 4 — PRODUCTION Verify. Read-only against both
 * production PostgreSQL (via the export-production.json snapshot
 * already captured by export-postgres-production.js — no fresh
 * PostgreSQL connection is opened here at all) and production D1.
 *
 * Runs the exact same check suite as verify-migration.js
 * (lib/verify-checks.js) — row counts, PK set equality, FK/self-
 * referential orphan checks, boolean fidelity, JSON round-trip fidelity,
 * money/decimal round-trip fidelity — pointed at
 * migration-data/export-production.json and the real production D1 via
 * --config wrangler.production.jsonc --remote.
 *
 * Gated by assertProductionD1AccessAllowed() — same requirements as
 * import-d1-production.js.
 */
const fs = require('fs');
const path = require('path');
const { assertProductionD1AccessAllowed, PRODUCTION_D1_DATABASE_NAME, PRODUCTION_WRANGLER_CONFIG } = require('./lib/safety');
const { runAllChecks } = require('./lib/verify-checks');
const { runWranglerCapture } = require('./lib/run-wrangler');

const DATA_DIR = path.join(__dirname, 'migration-data');
const EXPORT_FILE = path.join(DATA_DIR, 'export-production.json');
const BACKEND_DIR = path.join(__dirname, '..', '..');

// --command (not --file): --remote --file returns an execution-summary
// object, not real rows (confirmed in Phase 12) — see lib/run-wrangler.js
// for why --command is safe here despite the historical Windows
// shell-splitting bug that ruled it out for the local scripts.
function d1Query(sql) {
  const out = runWranglerCapture(BACKEND_DIR, [
    'd1', 'execute', PRODUCTION_D1_DATABASE_NAME, '--remote', '--config', PRODUCTION_WRANGLER_CONFIG, '--json', '--command', sql,
  ]);
  const parsed = JSON.parse(out);
  return parsed[0].results;
}

function main() {
  assertProductionD1AccessAllowed('verify-migration-production.js');

  if (!fs.existsSync(EXPORT_FILE)) {
    console.error(`[verify-production] ${EXPORT_FILE} not found — run export-postgres-production.js first.`);
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8')).tables;

  const { failures } = runAllChecks(src, d1Query);
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED against PRODUCTION D1.`);
    process.exit(1);
  }
  console.log('All verification checks passed against PRODUCTION D1.');
}

main();
