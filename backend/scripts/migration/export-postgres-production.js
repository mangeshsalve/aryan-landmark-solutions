'use strict';

/**
 * Phase 13, Step 1 of 4 — PRODUCTION Export.
 *
 * Reads every row of all 8 application tables from the REAL production
 * PostgreSQL database, read-only, and writes a JSON snapshot — otherwise
 * identical row-fetching/tagging logic to export-postgres.js (same
 * TABLES list, same serializeValue BigInt/Date/Decimal tagging), because
 * this must produce output transform-data.js can consume unchanged.
 *
 * Differences from export-postgres.js, all deliberate:
 *   - Connects via PRODUCTION_DATABASE_URL (passed as Prisma's
 *     `datasourceUrl` constructor option), never DATABASE_URL — the two
 *     variables are never read by the same script.
 *   - Gated by assertProductionPostgresReadAllowed(), not
 *     assertMigrationAllowed() — see lib/safety.js. That function
 *     actively refuses anything production-shaped; this one actively
 *     requires it.
 *   - Writes migration-data/export-production.json — a different
 *     filename from export.json, so a production snapshot can never be
 *     silently confused with local test data by transform-data.js or a
 *     human skimming the directory.
 *
 * This script's only Prisma calls are findMany() — there is no
 * create/update/delete/upsert/executeRaw call anywhere in this file.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { assertProductionPostgresReadAllowed } = require('./lib/safety');

const OUT_DIR = path.join(__dirname, 'migration-data');
const OUT_FILE = path.join(OUT_DIR, 'export-production.json');

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

function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { __type: 'bigint', value: value.toString() };
  if (value instanceof Date) return { __type: 'date', value: value.toISOString() };
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
  assertProductionPostgresReadAllowed('export-postgres-production.js');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prisma = new PrismaClient({ datasourceUrl: process.env.PRODUCTION_DATABASE_URL });
  const snapshot = { exportedAt: new Date().toISOString(), source: 'PRODUCTION', tables: {} };
  const rowCounts = {};

  try {
    for (const { model, name } of TABLES) {
      const rows = await prisma[model].findMany({ orderBy: { id: 'asc' } });
      snapshot.tables[name] = rows.map(serializeValue);
      rowCounts[name] = rows.length;
      console.log(`[export-production] ${name}: ${rows.length} row(s)`);
    }
  } finally {
    await prisma.$disconnect();
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`[export-production] Wrote ${OUT_FILE}`);
  console.log('[export-production] Row count summary:', JSON.stringify(rowCounts));
}

main().catch((err) => {
  console.error('[export-production] FAILED:', err);
  process.exitCode = 1;
});
