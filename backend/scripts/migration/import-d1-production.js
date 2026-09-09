'use strict';

/**
 * Phase 13, Step 3 of 4 — PRODUCTION Import.
 *
 * Reads migration-data/transformed-production.json (produced by
 * transform-data.js run with MIGRATION_EXPORT_FILE=export-production.json
 * MIGRATION_TRANSFORMED_FILE=transformed-production.json) and writes to
 * the REAL production D1 database, using the exact same batch-building
 * logic (lib/batch-builder.js) already proven in Phase 10/11 — same
 * table order, same two-pass users self-referential FK handling, same
 * chunking. Nothing about *how* rows are batched or ordered differs
 * between local and production; only *where* they're sent does.
 *
 * Gated by assertProductionD1AccessAllowed() (lib/safety.js) — requires
 * ALLOW_PRODUCTION_MIGRATION=true, an exact PRODUCTION_MIGRATION_CONFIRM
 * phrase, and D1_PRODUCTION_DATABASE_NAME=aryan-landmark-production as an
 * independent re-confirmation of the target, on top of whatever
 * wrangler.production.jsonc itself says. --remote and --config
 * wrangler.production.jsonc are hardcoded below — there is no flag or
 * environment variable that can redirect this script's writes anywhere
 * else, symmetric with how import-d1.js hardcodes --local.
 *
 * Per Phase 13's explicit instruction: if any batch fails, this script
 * stops immediately (it does not catch-and-continue to the next batch)
 * and reports exactly which batch failed, its file, and its position —
 * the caller must diagnose and decide whether to retry, not this script.
 */
const fs = require('fs');
const path = require('path');
const { assertProductionD1AccessAllowed, PRODUCTION_D1_DATABASE_NAME, PRODUCTION_WRANGLER_CONFIG } = require('./lib/safety');
const { buildBatches } = require('./lib/batch-builder');
const { runWranglerInherit } = require('./lib/run-wrangler');

const DATA_DIR = path.join(__dirname, 'migration-data');
const BATCH_DIR = path.join(DATA_DIR, 'batches-production');
const IN_FILE = path.join(DATA_DIR, 'transformed-production.json');
const BACKEND_DIR = path.join(__dirname, '..', '..');
const DEFAULT_BATCH_SIZE = 500;

function countRows(transformed) {
  return Object.values(transformed.tables).reduce((sum, rows) => sum + rows.length, 0);
}

function main() {
  assertProductionD1AccessAllowed('import-d1-production.js');

  if (!fs.existsSync(IN_FILE)) {
    console.error(`[import-production] ${IN_FILE} not found — run export-postgres-production.js then transform-data.js (with MIGRATION_EXPORT_FILE/MIGRATION_TRANSFORMED_FILE set) first.`);
    process.exit(1);
  }
  const transformed = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const totalRows = countRows(transformed);

  const batchSize = Number(process.env.MIGRATION_BATCH_SIZE) > 0 ? Number(process.env.MIGRATION_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
  console.log(`[import-production] Total source rows across all tables: ${totalRows}`);
  console.log(`[import-production] Using batch size: ${batchSize} row(s) per file (MIGRATION_BATCH_SIZE to override).`);

  fs.rmSync(BATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  const batches = buildBatches(transformed, batchSize);
  console.log(`[import-production] Generated ${batches.length} batch file(s).`);
  console.log(`[import-production] Target: D1 database "${PRODUCTION_D1_DATABASE_NAME}" via --config ${PRODUCTION_WRANGLER_CONFIG} --remote.`);

  let succeeded = 0;
  for (const [i, batch] of batches.entries()) {
    const filePath = path.join(BATCH_DIR, `${String(i + 1).padStart(4, '0')}-${batch.label}.sql`);
    fs.writeFileSync(filePath, batch.sql, 'utf8');
    console.log(`[import-production]   (${i + 1}/${batches.length}) ${batch.label}...`);
    try {
      runWranglerInherit(BACKEND_DIR, [
        'd1', 'execute', PRODUCTION_D1_DATABASE_NAME, '--remote', '--config', PRODUCTION_WRANGLER_CONFIG, '--file', filePath,
      ]);
      succeeded++;
    } catch (err) {
      console.error('');
      console.error(`[import-production] BATCH FAILED at (${i + 1}/${batches.length}): ${batch.label}`);
      console.error(`[import-production] Batch file: ${filePath}`);
      console.error(`[import-production] Batches succeeded before failure: ${succeeded}/${batches.length}`);
      console.error('[import-production] STOPPING — not continuing to remaining batches. Diagnose before retrying.');
      console.error(err.message || err);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[import-production] Done. ${succeeded}/${batches.length} batch(es) succeeded, 0 failed.`);
}

main();
