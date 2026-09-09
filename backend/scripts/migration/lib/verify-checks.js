'use strict';

/**
 * Shared verification logic, extracted from Phase 10/11's
 * verify-migration.js so Phase 13's production verification runs the
 * exact same 38-check logic already proven locally (row counts, PK set
 * equality, FK orphan checks, boolean fidelity, JSON round-trip fidelity,
 * money/decimal round-trip fidelity) rather than a re-typed copy that
 * could silently diverge. Parametrized only by `src` (the exported
 * PostgreSQL snapshot's `.tables`) and `d1Query(sql)` (a function that
 * runs a read-only SELECT against whichever D1 database — local or
 * production — and returns `results`), so this module itself has no
 * opinion about which target it's checking.
 */

function tagged(value) {
  if (value && typeof value === 'object' && '__type' in value && 'value' in value) return value.value;
  return value;
}

const TABLES = ['users', 'properties', 'inquiries', 'inquiry_assignments', 'attachments', 'follow_ups', 'notifications', 'audit_logs'];

const FK_CHECKS = [
  ['properties.created_by -> users.id', "SELECT COUNT(*) AS c FROM properties WHERE created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM users)"],
  ['inquiries.customer_id -> users.id', "SELECT COUNT(*) AS c FROM inquiries WHERE customer_id IS NOT NULL AND customer_id NOT IN (SELECT id FROM users)"],
  ['inquiries.property_id -> properties.id', "SELECT COUNT(*) AS c FROM inquiries WHERE property_id IS NOT NULL AND property_id NOT IN (SELECT id FROM properties)"],
  ['inquiries.created_by -> users.id', "SELECT COUNT(*) AS c FROM inquiries WHERE created_by NOT IN (SELECT id FROM users)"],
  ['inquiry_assignments.inquiry_id -> inquiries.id', "SELECT COUNT(*) AS c FROM inquiry_assignments WHERE inquiry_id NOT IN (SELECT id FROM inquiries)"],
  ['inquiry_assignments.assigned_to_user_id -> users.id', "SELECT COUNT(*) AS c FROM inquiry_assignments WHERE assigned_to_user_id NOT IN (SELECT id FROM users)"],
  ['attachments.property_id -> properties.id', "SELECT COUNT(*) AS c FROM attachments WHERE property_id IS NOT NULL AND property_id NOT IN (SELECT id FROM properties)"],
  ['attachments.inquiry_id -> inquiries.id', "SELECT COUNT(*) AS c FROM attachments WHERE inquiry_id IS NOT NULL AND inquiry_id NOT IN (SELECT id FROM inquiries)"],
  ['attachments.uploaded_by -> users.id', "SELECT COUNT(*) AS c FROM attachments WHERE uploaded_by NOT IN (SELECT id FROM users)"],
  ['follow_ups.inquiry_id -> inquiries.id', "SELECT COUNT(*) AS c FROM follow_ups WHERE inquiry_id NOT IN (SELECT id FROM inquiries)"],
  ['notifications.user_id -> users.id', "SELECT COUNT(*) AS c FROM notifications WHERE user_id NOT IN (SELECT id FROM users)"],
  ['audit_logs.user_id -> users.id', "SELECT COUNT(*) AS c FROM audit_logs WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)"],
  // Phase 13 addition: explicit self-referential check, called out by
  // name in the Phase 13 prompt even though it's a subset of the
  // properties/inquiries created_by checks already above for users
  // itself specifically.
  ['users.created_by -> users.id', "SELECT COUNT(*) AS c FROM users WHERE created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM users)"],
  ['users.updated_by -> users.id', "SELECT COUNT(*) AS c FROM users WHERE updated_by IS NOT NULL AND updated_by NOT IN (SELECT id FROM users)"],
];

const BOOL_FIELDS = [
  ['properties', 'isPublic', 'is_public', true],
  ['inquiries', 'isPublic', 'is_public', false],
  ['attachments', 'isPrimary', 'is_primary', false],
  ['follow_ups', 'reminderEnabled', 'reminder_enabled', false],
  ['notifications', 'isRead', 'is_read', false],
];

/**
 * Runs the full check suite. `src` is the PostgreSQL export's `.tables`
 * object; `d1Query(sql)` executes a read-only SELECT against D1 and
 * returns its `results` array. Returns { checks, failures }.
 */
function runAllChecks(src, d1Query) {
  let failures = 0;
  let checks = 0;

  function check(label, pass, detail) {
    checks++;
    if (pass) {
      console.log(`  [PASS] ${label}`);
    } else {
      failures++;
      console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    }
  }

  console.log('=== Row counts ===');
  for (const t of TABLES) {
    const srcCount = src[t].length;
    const [{ count: d1Count }] = d1Query(`SELECT COUNT(*) AS count FROM ${t};`);
    check(`${t}: PostgreSQL ${srcCount} == D1 ${d1Count}`, srcCount === d1Count);
  }

  console.log('\n=== Primary key set equality ===');
  for (const t of TABLES) {
    const srcIds = new Set(src[t].map((r) => r.id));
    const d1Rows = d1Query(`SELECT id FROM ${t};`);
    const d1Ids = new Set(d1Rows.map((r) => r.id));
    const missing = [...srcIds].filter((id) => !d1Ids.has(id));
    const extra = [...d1Ids].filter((id) => !srcIds.has(id));
    check(`${t}: id sets identical`, missing.length === 0 && extra.length === 0, missing.length || extra.length ? `missing=${missing.length} extra=${extra.length}` : undefined);
  }

  console.log('\n=== Foreign key / self-referential orphan checks (D1) ===');
  for (const [label, sql] of FK_CHECKS) {
    const [{ c }] = d1Query(sql);
    check(`no orphans: ${label}`, c === 0, `${c} orphan row(s)`);
  }

  console.log('\n=== Boolean fidelity ===');
  for (const [table, pgField, d1Field, nullable] of BOOL_FIELDS) {
    const d1Rows = d1Query(`SELECT id, ${d1Field} FROM ${table};`);
    const d1ById = new Map(d1Rows.map((r) => [r.id, r[d1Field]]));
    let mismatches = 0;
    for (const row of src[table]) {
      const pgVal = row[pgField];
      const d1Val = d1ById.get(row.id);
      const expected = pgVal === null ? (nullable ? null : 0) : pgVal ? 1 : 0;
      if (d1Val !== expected) mismatches++;
    }
    check(`${table}.${d1Field} matches ${table}.${pgField} for all ${src[table].length} row(s)`, mismatches === 0, `${mismatches} mismatch(es)`);
  }

  console.log('\n=== JSON round-trip fidelity (audit_logs) ===');
  const d1Audits = d1Query('SELECT id, old_values, new_values FROM audit_logs;');
  const d1AuditById = new Map(d1Audits.map((r) => [r.id, r]));
  let jsonMismatches = 0;
  let jsonParseFailures = 0;
  for (const row of src.audit_logs) {
    const d1Row = d1AuditById.get(row.id);
    for (const [pgField, d1Field] of [['oldValues', 'old_values'], ['newValues', 'new_values']]) {
      const pgVal = row[pgField];
      const d1Text = d1Row ? d1Row[d1Field] : undefined;
      if (pgVal === null) {
        if (d1Text !== null) jsonMismatches++;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(d1Text);
      } catch {
        jsonParseFailures++;
        continue;
      }
      if (JSON.stringify(parsed) !== JSON.stringify(pgVal)) jsonMismatches++;
    }
  }
  check(`all ${src.audit_logs.length} audit_logs JSON fields parse as valid JSON`, jsonParseFailures === 0, `${jsonParseFailures} parse failure(s)`);
  check(`all audit_logs JSON fields structurally match source`, jsonMismatches === 0, `${jsonMismatches} mismatch(es)`);

  console.log('\n=== Money / decimal round-trip fidelity ===');
  const d1Props = d1Query('SELECT id, price_minor_units, area, latitude, longitude FROM properties;');
  const d1PropById = new Map(d1Props.map((r) => [r.id, r]));
  let priceMismatches = 0;
  let areaMismatches = 0;
  for (const row of src.properties) {
    const d1Row = d1PropById.get(row.id);
    const pgPrice = tagged(row.price);
    if (pgPrice === null) {
      if (d1Row.price_minor_units !== null) priceMismatches++;
    } else {
      const reconstructed = (d1Row.price_minor_units / 100).toFixed(2);
      if (reconstructed !== Number(pgPrice).toFixed(2)) priceMismatches++;
    }
    const pgArea = tagged(row.area);
    if (pgArea === null) {
      if (d1Row.area !== null) areaMismatches++;
    } else if (Number(d1Row.area) !== Number(pgArea)) {
      areaMismatches++;
    }
  }
  check(`properties.price round-trips exactly via price_minor_units for all ${src.properties.length} row(s)`, priceMismatches === 0, `${priceMismatches} mismatch(es)`);
  check(`properties.area round-trips exactly (REAL) for all ${src.properties.length} row(s)`, areaMismatches === 0, `${areaMismatches} mismatch(es)`);

  const d1Inqs = d1Query('SELECT id, max_budget_minor_units FROM inquiries;');
  const d1InqById = new Map(d1Inqs.map((r) => [r.id, r]));
  let budgetMismatches = 0;
  for (const row of src.inquiries) {
    const d1Row = d1InqById.get(row.id);
    const pgBudget = tagged(row.maxBudget);
    if (pgBudget === null) {
      if (d1Row.max_budget_minor_units !== null) budgetMismatches++;
    } else {
      const reconstructed = (d1Row.max_budget_minor_units / 100).toFixed(2);
      if (reconstructed !== Number(pgBudget).toFixed(2)) budgetMismatches++;
    }
  }
  check(`inquiries.maxBudget round-trips exactly via max_budget_minor_units for all ${src.inquiries.length} row(s)`, budgetMismatches === 0, `${budgetMismatches} mismatch(es)`);

  console.log(`\n=== Summary: ${checks - failures}/${checks} checks passed ===`);
  return { checks, failures };
}

module.exports = { runAllChecks, TABLES };
