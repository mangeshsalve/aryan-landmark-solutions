'use strict';

/**
 * Phase 10 — clears all 8 application tables in the LOCAL D1 database
 * (child-to-parent FK-safe order), without touching D1's own migration-
 * bookkeeping tables or the `.wrangler/state` directory itself. This
 * makes the export -> transform -> import -> verify cycle repeatable on
 * demand: reset, then re-run import-d1.js, with no manual repair step.
 *
 * `--local` is hardcoded — same as import-d1.js, there is no code path
 * here that can reach a remote/production D1 database.
 *
 * Found necessary in practice: this local D1 database already had
 * leftover rows from Phase 1's very first schema-validation testing
 * (non-UUID ids like "u-admin", never cleaned up since) sitting
 * alongside every later phase's properly-cleaned-up test data. Rather
 * than importing on top of that old cruft, this script clears it first
 * so row-count verification (Section 9) has an unambiguous baseline.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertMigrationAllowed } = require('./lib/safety');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const D1_DATABASE_NAME = 'aryan-landmark-backend-local-only';
const RESET_SQL_FILE = path.join(__dirname, 'migration-data', 'reset.sql');

// Child-to-parent order — the reverse of import-d1.js's TABLE_ORDER.
const DELETE_ORDER = ['audit_logs', 'notifications', 'follow_ups', 'attachments', 'inquiry_assignments', 'inquiries', 'properties', 'users'];

function main() {
  assertMigrationAllowed('reset-d1.js');

  fs.mkdirSync(path.dirname(RESET_SQL_FILE), { recursive: true });
  const sql = DELETE_ORDER.map((t) => `DELETE FROM ${t};`).join('\n') + '\n';
  fs.writeFileSync(RESET_SQL_FILE, sql, 'utf8');

  // --file (not --command) — a multi-statement string passed via
  // --command does not survive shell quoting reliably on Windows
  // (confirmed empirically: the newline-separated statements get split
  // into separate argv words and wrangler rejects them as "Unknown
  // arguments"). Every other script in this tooling uses --file for the
  // same reason.
  console.log('[reset-d1] Clearing all 8 application tables in LOCAL D1...');
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--local', '--config', 'wrangler.jsonc', '--file', RESET_SQL_FILE],
    { cwd: BACKEND_DIR, stdio: 'inherit', shell: true },
  );
  console.log('[reset-d1] Done — all application tables empty.');
}

main();
