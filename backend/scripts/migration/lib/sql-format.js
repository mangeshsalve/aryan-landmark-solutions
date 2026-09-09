'use strict';

/**
 * Renders a single JS value as a SQLite/D1 SQL literal for the generated
 * import.sql file. Used only for Phase 10's offline migration tooling —
 * every value here originates from our own transform-data.js output
 * (never directly from an HTTP request), but is still escaped properly
 * rather than trusted, as a matter of correctness (real data legitimately
 * contains apostrophes — "O'Brien", "Owner's Society" — not just as a
 * hypothetical injection concern).
 */
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot render non-finite number as SQL literal: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  // Strings (and anything else, stringified first): standard SQL
  // single-quote escaping — a literal `'` becomes `''`.
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

function buildInsert(table, columns, row) {
  const values = columns.map((c) => sqlLiteral(row[c]));
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}

module.exports = { sqlLiteral, buildInsert };
