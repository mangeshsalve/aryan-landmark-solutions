'use strict';

/**
 * Phase 10, Step 4 of 4 — Verify (LOCAL). Read-only against both
 * PostgreSQL (via the export.json snapshot) and LOCAL D1.
 *
 * Phase 13: the actual check logic now lives in lib/verify-checks.js so
 * this file and verify-migration-production.js run byte-identical
 * checks — this file only supplies the local file path and the local
 * `--local --config wrangler.jsonc` D1 query function.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertMigrationAllowed } = require('./lib/safety');
const { runAllChecks } = require('./lib/verify-checks');

const DATA_DIR = path.join(__dirname, 'migration-data');
const EXPORT_FILE = path.join(DATA_DIR, 'export.json');
const BACKEND_DIR = path.join(__dirname, '..', '..');
const D1_DATABASE_NAME = 'aryan-landmark-backend-local-only';

const QUERY_TMP_FILE = path.join(DATA_DIR, 'verify-query.sql');

// --file, not --command: a SQL string containing spaces does not survive
// shell:true argument passing reliably on Windows (confirmed empirically
// — cmd.exe re-splits the "single" argument on whitespace, and wrangler
// then sees each word as a separate, unrecognized positional argument).
function d1Query(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUERY_TMP_FILE, sql, 'utf8');
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--local', '--config', 'wrangler.jsonc', '--json', '--file', QUERY_TMP_FILE],
    { cwd: BACKEND_DIR, shell: true, encoding: 'utf8' },
  );
  const parsed = JSON.parse(out);
  return parsed[0].results;
}

function main() {
  assertMigrationAllowed('verify-migration.js');

  if (!fs.existsSync(EXPORT_FILE)) {
    console.error(`[verify] ${EXPORT_FILE} not found — run export-postgres.js first.`);
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8')).tables;

  const { failures } = runAllChecks(src, d1Query);
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All verification checks passed.');
}

main();
