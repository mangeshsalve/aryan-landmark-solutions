'use strict';

/**
 * Phase 10, Step 2 of 4 — Transform.
 *
 * Reads migration-data/export.json (PostgreSQL snapshot, Prisma-shaped
 * camelCase rows) and writes migration-data/transformed.json: one entry
 * per D1 table, each row already in exact D1 column-name/shape/type form
 * — the same shape routes/*.ts already reads via `SELECT ... FROM
 * <table>`. No PostgreSQL or D1 connection is used in this step at all;
 * it is a pure, offline, re-runnable data transformation, matching this
 * phase's Type Transformation Matrix (see the final report):
 *
 *   UUID            -> TEXT, preserved byte-for-byte (no regeneration)
 *   BOOLEAN          -> INTEGER 0/1 (NULL stays NULL)
 *   JSON/JSONB        -> TEXT (JSON.stringify'd; NULL stays NULL)
 *   TIMESTAMPTZ       -> TEXT, ISO-8601 UTC string (matches nowIso() in
 *                        src/worker/utils/id.ts and every existing
 *                        Worker-written timestamp)
 *   DECIMAL money      -> INTEGER minor units (paise) — price/maxBudget
 *                        ONLY, via Math.round(rupees * 100), the exact
 *                        same function as src/worker/utils/money.ts's
 *                        rupeesToMinorUnits()
 *   DECIMAL area/lat/lng -> REAL (plain float), no unit conversion
 *   BIGINT (fileSizeBytes) -> INTEGER (safe: file sizes are always far
 *                        below Number.MAX_SAFE_INTEGER)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'migration-data');
// Phase 13: overridable so export-production.json can be transformed into
// transformed-production.json without duplicating the transformer
// functions below — defaults are byte-identical to Phase 10's original
// behavior when these env vars are unset, so local usage is unaffected.
const IN_FILE = path.join(DATA_DIR, process.env.MIGRATION_EXPORT_FILE || 'export.json');
const OUT_FILE = path.join(DATA_DIR, process.env.MIGRATION_TRANSFORMED_FILE || 'transformed.json');

function tagged(value) {
  if (value && typeof value === 'object' && '__type' in value && 'value' in value) return value.value;
  return value;
}

function toIso(value) {
  const v = tagged(value);
  return v === null || v === undefined ? null : v;
}

function toBool01(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function toBool01NotNull(value) {
  return value ? 1 : 0;
}

/** Matches src/worker/utils/money.ts's rupeesToMinorUnits() exactly. */
function toMinorUnits(value) {
  const v = tagged(value);
  if (v === null || v === undefined) return null;
  return Math.round(Number(v) * 100);
}

function toRealOrNull(value) {
  const v = tagged(value);
  if (v === null || v === undefined) return null;
  return Number(v);
}

function toBigintNumber(value) {
  const v = tagged(value);
  if (v === null || v === undefined) return null;
  return Number(v);
}

function toJsonTextOrNull(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function transformUsers(rows) {
  return rows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    user_type: r.userType,
    role: r.role,
    name: r.name,
    email: r.email,
    mobile: r.mobile,
    alternate_mobile: r.alternateMobile,
    address: r.address,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    password_hash: r.passwordHash,
    status: r.status,
    last_login_at: toIso(r.lastLoginAt),
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    created_by: r.createdByUserId,
    updated_by: r.updatedByUserId,
  }));
}

function transformProperties(rows) {
  return rows.map((r) => ({
    id: r.id,
    property_code: r.propertyCode,
    property_type: r.propertyType,
    category: r.category,
    area: toRealOrNull(r.area),
    area_unit: r.areaUnit,
    price_minor_units: toMinorUnits(r.price),
    price_unit: r.priceUnit,
    gat_no_details: r.gatNoDetails,
    description: r.description,
    address: r.address,
    locality: r.locality,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    latitude: toRealOrNull(r.latitude),
    longitude: toRealOrNull(r.longitude),
    map_url: r.mapUrl,
    status: r.status,
    is_public: toBool01(r.isPublic),
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    created_by: r.createdByUserId,
    updated_by: r.updatedByUserId,
  }));
}

function transformInquiries(rows) {
  return rows.map((r) => ({
    id: r.id,
    inquiry_number: r.inquiryNumber,
    customer_id: r.customerId,
    property_id: r.propertyId,
    type: r.type,
    priority: r.priority,
    status: r.status,
    external_reference: r.externalReference,
    handled_by_user_id: r.handledByUserId,
    assigned_to_user_id: r.assignedToUserId,
    remarks: r.remarks,
    is_public: toBool01NotNull(r.isPublic),
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    locality: r.locality,
    max_budget_minor_units: toMinorUnits(r.maxBudget),
    submitted_at: toIso(r.submittedAt),
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    created_by: r.createdByUserId,
    updated_by: r.updatedByUserId,
  }));
}

function transformInquiryAssignments(rows) {
  return rows.map((r) => ({
    id: r.id,
    inquiry_id: r.inquiryId,
    assigned_from_user_id: r.assignedFromUserId,
    assigned_to_user_id: r.assignedToUserId,
    assigned_at: toIso(r.assignedAt),
    reason: r.reason,
    created_by: r.createdByUserId,
  }));
}

function transformAttachments(rows) {
  return rows.map((r) => ({
    id: r.id,
    property_id: r.propertyId,
    inquiry_id: r.inquiryId,
    attachment_type: r.attachmentType,
    document_type: r.documentType,
    file_name: r.fileName,
    mime_type: r.mimeType,
    file_size_bytes: toBigintNumber(r.fileSizeBytes),
    r2_bucket: r.r2Bucket,
    r2_object_key: r.r2ObjectKey,
    file_url: r.fileUrl,
    is_primary: toBool01NotNull(r.isPrimary),
    display_order: r.displayOrder,
    uploaded_by: r.uploadedByUserId,
    created_at: toIso(r.createdAt),
  }));
}

function transformFollowUps(rows) {
  return rows.map((r) => ({
    id: r.id,
    inquiry_id: r.inquiryId,
    scheduled_at: toIso(r.scheduledAt),
    status: r.status,
    notes: r.notes,
    reminder_enabled: toBool01NotNull(r.reminderEnabled),
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
    created_by: r.createdByUserId,
    updated_by: r.updatedByUserId,
  }));
}

function transformNotifications(rows) {
  return rows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    type: r.type,
    title: r.title,
    message: r.message,
    entity_type: r.entityType,
    entity_id: r.entityId,
    is_read: toBool01NotNull(r.isRead),
    read_at: toIso(r.readAt),
    created_at: toIso(r.createdAt),
  }));
}

function transformAuditLogs(rows) {
  return rows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    entity_type: r.entityType,
    entity_id: r.entityId,
    action: r.action,
    old_values: toJsonTextOrNull(r.oldValues),
    new_values: toJsonTextOrNull(r.newValues),
    ip_address: r.ipAddress,
    user_agent: r.userAgent,
    created_at: toIso(r.createdAt),
  }));
}

const TRANSFORMERS = {
  users: transformUsers,
  properties: transformProperties,
  inquiries: transformInquiries,
  inquiry_assignments: transformInquiryAssignments,
  attachments: transformAttachments,
  follow_ups: transformFollowUps,
  notifications: transformNotifications,
  audit_logs: transformAuditLogs,
};

function main() {
  if (!fs.existsSync(IN_FILE)) {
    console.error(`[transform] ${IN_FILE} not found — run export-postgres.js first.`);
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const out = { transformedAt: new Date().toISOString(), sourceExportedAt: snapshot.exportedAt, tables: {} };

  for (const [table, transform] of Object.entries(TRANSFORMERS)) {
    const rows = snapshot.tables[table] || [];
    out.tables[table] = transform(rows);
    console.log(`[transform] ${table}: ${rows.length} row(s)`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[transform] Wrote ${OUT_FILE}`);
}

main();
