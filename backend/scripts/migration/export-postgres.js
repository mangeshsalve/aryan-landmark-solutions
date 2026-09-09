'use strict';

/**
 * Phase 10, Step 1 of 4 — Export.
 *
 * Reads every row of all 8 application tables from the local PostgreSQL
 * database (via the existing, already-generated Prisma Client — no new
 * DB-driver dependency needed) and writes one JSON snapshot file. This
 * step is read-only against PostgreSQL: it never writes, updates, or
 * deletes anything there.
 *
 * BigInt (attachments.fileSizeBytes) and Decimal (properties.price/area/
 * latitude/longitude, inquiries.maxBudget) values are not natively
 * JSON-serializable — both are converted to plain strings here (not
 * numbers, to avoid any intermediate float rounding before
 * transform-data.js does the real, deliberate conversion) and tagged so
 * the next step knows how to interpret them.
 *
 * Output: scripts/migration/migration-data/export.json (gitignored).
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { assertMigrationAllowed } = require('./lib/safety');

const prisma = new PrismaClient();
const OUT_DIR = path.join(__dirname, 'migration-data');
const OUT_FILE = path.join(OUT_DIR, 'export.json');

// Table export order matches the FK dependency order documented in
// README.md (parents before children) — not required for a read-only
// export, but keeping it consistent makes the JSON file easier to read
// and matches the order the later import step must use.
const TABLES = [
  { model: 'user', name: 'users' },
  { model: 'property', name: 'properties' },
  { model: 'inquiry', name: 'inquiries' },
  { model: 'inquiryAssignment', name: 'inquiry_assignments' },
  { model: 'attachment', name: 'attachments' },
  { model: 'followUp', name: 'follow_ups' },
  { model: 'notification', name: 'notifications' },
  { model: 'auditLog', name: 'audit_logs' },
];

/** Recursively replaces BigInt/Decimal-like values with tagged strings so JSON.stringify never throws. */
function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { __type: 'bigint', value: value.toString() };
  if (value instanceof Date) return { __type: 'date', value: value.toISOString() };
  // Prisma's Decimal.js is bundled with a minified constructor name (seen
  // as literally "i" in this project's generated client), so
  // `constructor.name === 'Decimal'` never matches — confirmed empirically
  // before relying on it. Object.prototype.toString via Symbol.toStringTag
  // is what decimal.js actually sets and is minification-proof.
  if (typeof value === 'object' && Object.prototype.toString.call(value) === '[object Decimal]') {
    return { __type: 'decimal', value: value.toString() };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

async function main() {
  assertMigrationAllowed('export-postgres.js');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const snapshot = { exportedAt: new Date().toISOString(), tables: {} };

  for (const { model, name } of TABLES) {
    const rows = await prisma[model].findMany({ orderBy: { id: 'asc' } });
    snapshot.tables[name] = rows.map(serializeValue);
    console.log(`[export] ${name}: ${rows.length} row(s)`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`[export] Wrote ${OUT_FILE}`);
}

main()
  .catch((err) => {
    console.error('[export] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
