'use strict';

/**
 * Shared batch-building logic for D1 import, extracted from Phase 10/11's
 * import-d1.js so the same, already-proven (38/38 checks, twice, at
 * batch sizes 2 and 500) chunking + two-pass-users logic is used by both
 * the local-only importer and Phase 13's production importer — a
 * production run must never run through a re-typed copy of this logic
 * that could silently drift from what was actually tested.
 */
const { sqlLiteral, buildInsert } = require('./sql-format');

const TABLE_COLUMNS = {
  users: [
    'id', 'user_id', 'user_type', 'role', 'name', 'email', 'mobile', 'alternate_mobile',
    'address', 'city', 'state', 'pincode', 'password_hash', 'status', 'last_login_at',
    'created_at', 'updated_at', 'created_by', 'updated_by',
  ],
  properties: [
    'id', 'property_code', 'property_type', 'category', 'area', 'area_unit',
    'price_minor_units', 'price_unit', 'gat_no_details', 'description', 'address',
    'locality', 'city', 'state', 'pincode', 'latitude', 'longitude', 'map_url', 'status',
    'is_public', 'created_at', 'updated_at', 'created_by', 'updated_by',
  ],
  inquiries: [
    'id', 'inquiry_number', 'customer_id', 'property_id', 'type', 'priority', 'status',
    'external_reference', 'handled_by_user_id', 'assigned_to_user_id', 'remarks',
    'is_public', 'city', 'state', 'pincode', 'locality', 'max_budget_minor_units',
    'submitted_at', 'created_at', 'updated_at', 'created_by', 'updated_by',
  ],
  inquiry_assignments: [
    'id', 'inquiry_id', 'assigned_from_user_id', 'assigned_to_user_id', 'assigned_at',
    'reason', 'created_by',
  ],
  attachments: [
    'id', 'property_id', 'inquiry_id', 'attachment_type', 'document_type', 'file_name',
    'mime_type', 'file_size_bytes', 'r2_bucket', 'r2_object_key', 'file_url', 'is_primary',
    'display_order', 'uploaded_by', 'created_at',
  ],
  follow_ups: [
    'id', 'inquiry_id', 'scheduled_at', 'status', 'notes', 'reminder_enabled', 'created_at',
    'updated_at', 'created_by', 'updated_by',
  ],
  notifications: [
    'id', 'user_id', 'type', 'title', 'message', 'entity_type', 'entity_id', 'is_read',
    'read_at', 'created_at',
  ],
  audit_logs: [
    'id', 'user_id', 'entity_type', 'entity_id', 'action', 'old_values', 'new_values',
    'ip_address', 'user_agent', 'created_at',
  ],
};

const TABLE_ORDER = ['users', 'properties', 'inquiries', 'inquiry_assignments', 'attachments', 'follow_ups', 'notifications', 'audit_logs'];

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function header(label) {
  return [
    '-- Migration import batch — DO NOT hand-edit.',
    `-- ${label}`,
    `-- Generated at: ${new Date().toISOString()}`,
    '',
  ];
}

/** Builds the ordered list of { label, sql } batch files for the whole import. */
function buildBatches(transformed, batchSize) {
  const batches = [];
  const users = transformed.tables.users || [];

  for (const [i, rows] of chunk(users, batchSize).entries()) {
    const lines = header(`users pass 1/2, batch ${i + 1} (${rows.length} row(s))`);
    for (const row of rows) {
      lines.push(buildInsert('users', TABLE_COLUMNS.users, { ...row, created_by: null, updated_by: null }));
    }
    batches.push({ label: `users-pass1-batch${i + 1}`, sql: lines.join('\n') + '\n' });
  }

  for (const table of TABLE_ORDER) {
    if (table === 'users') continue;
    const rows = transformed.tables[table] || [];
    for (const [i, rowChunk] of chunk(rows, batchSize).entries()) {
      const lines = header(`${table}, batch ${i + 1} (${rowChunk.length} row(s))`);
      for (const row of rowChunk) lines.push(buildInsert(table, TABLE_COLUMNS[table], row));
      batches.push({ label: `${table}-batch${i + 1}`, sql: lines.join('\n') + '\n' });
    }
  }

  const usersNeedingBackfill = users.filter((r) => r.created_by !== null || r.updated_by !== null);
  for (const [i, rows] of chunk(usersNeedingBackfill, batchSize).entries()) {
    const lines = header(`users pass 2/2 (backfill), batch ${i + 1} (${rows.length} row(s))`);
    for (const row of rows) {
      lines.push(`UPDATE users SET created_by = ${sqlLiteral(row.created_by)}, updated_by = ${sqlLiteral(row.updated_by)} WHERE id = ${sqlLiteral(row.id)};`);
    }
    batches.push({ label: `users-pass2-batch${i + 1}`, sql: lines.join('\n') + '\n' });
  }

  return batches;
}

module.exports = { TABLE_COLUMNS, TABLE_ORDER, chunk, buildBatches };
