'use strict';

/**
 * Phase 10, Step 3 of 4 — Import. Phase 11: added configurable batching.
 *
 * Reads migration-data/transformed.json and generates one or more SQL
 * files under migration-data/batches/, then executes them sequentially
 * against the LOCAL D1 database via `wrangler d1 execute --local
 * --config wrangler.jsonc --file=...`. The `--local` flag is hardcoded
 * in this file — there is no code path here that can be pointed at
 * `--remote`; a real production import is a distinct, future,
 * explicitly-approved action, not something this tooling can do by
 * accident or by flag.
 *
 * Table insertion order (parents before children), derived from the
 * actual foreign keys in migrations/0001_initial_schema.sql, not
 * assumed:
 *   users -> properties -> inquiries -> inquiry_assignments ->
 *   attachments -> follow_ups -> notifications -> audit_logs
 *
 * One genuine ordering wrinkle, found empirically (not assumed) by
 * inspecting the real local Postgres data: `users.created_by`/
 * `updated_by` are self-referential (a user's `created_by` can point at
 * another row in the very same table — e.g. a MASTER user created
 * several ADMIN/EMPLOYEE rows, one of whom then created a CUSTOMER row).
 * A single insert pass in arbitrary order can therefore violate D1's own
 * foreign-key enforcement (confirmed enforced in every prior phase's
 * testing) if a row's creator hasn't been inserted yet. Handled with the
 * standard two-pass technique: insert every user row with
 * created_by/updated_by temporarily NULL, then a second pass of UPDATE
 * statements backfills the real values once every user row exists. No
 * other table in this schema is self-referential, so every other table
 * uses a single straightforward INSERT pass.
 *
 * Batching (Phase 11): `wrangler d1 execute --file` has practical limits
 * on statement count/file size for very large imports (undocumented
 * exact threshold — Cloudflare's own guidance is "keep individual
 * execute calls reasonably sized"), and a single multi-thousand-row SQL
 * file is also simply harder to retry/resume if one table's import
 * fails partway. MIGRATION_BATCH_SIZE (default 500 rows per file) splits
 * every table's statements into that many rows per generated SQL file,
 * executed sequentially in the same global dependency order as the
 * unbatched version — set it to a number >= the largest table's row
 * count to reproduce the old single-file behavior exactly. Tested
 * locally this phase with a deliberately small batch size (2) against
 * the ~175-row local dataset to prove the mechanism itself, not because
 * that dataset actually requires batching at its current size.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertMigrationAllowed } = require('./lib/safety');
const { buildBatches } = require('./lib/batch-builder');

const DATA_DIR = path.join(__dirname, 'migration-data');
const BATCH_DIR = path.join(DATA_DIR, 'batches');
const IN_FILE = path.join(DATA_DIR, 'transformed.json');
const BACKEND_DIR = path.join(__dirname, '..', '..');
const D1_DATABASE_NAME = 'aryan-landmark-backend-local-only';
const DEFAULT_BATCH_SIZE = 500;

function main() {
  assertMigrationAllowed('import-d1.js');

  if (!fs.existsSync(IN_FILE)) {
    console.error(`[import] ${IN_FILE} not found — run export-postgres.js and transform-data.js first.`);
    process.exit(1);
  }
  const transformed = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));

  const batchSize = Number(process.env.MIGRATION_BATCH_SIZE) > 0 ? Number(process.env.MIGRATION_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
  console.log(`[import] Using batch size: ${batchSize} row(s) per file (set MIGRATION_BATCH_SIZE to override).`);

  fs.rmSync(BATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  const batches = buildBatches(transformed, batchSize);
  console.log(`[import] Generated ${batches.length} batch file(s).`);

  console.log('[import] Executing against LOCAL D1 only (--local, --config wrangler.jsonc)...');
  for (const [i, batch] of batches.entries()) {
    const filePath = path.join(BATCH_DIR, `${String(i + 1).padStart(4, '0')}-${batch.label}.sql`);
    fs.writeFileSync(filePath, batch.sql, 'utf8');
    console.log(`[import]   (${i + 1}/${batches.length}) ${batch.label}...`);
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--local', '--config', 'wrangler.jsonc', '--file', filePath],
      { cwd: BACKEND_DIR, stdio: 'inherit', shell: true },
    );
  }
  console.log('[import] Done.');
}

main();
