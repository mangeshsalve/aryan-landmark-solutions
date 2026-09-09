import { newId, nowIso } from './id';

/**
 * Worker/D1 equivalent of src/audit/audit.service.ts — Step 10.
 *
 * This is deliberately NOT ported from backend-d1-test: the POC skipped
 * audit logging entirely to move fast, and the earlier Phase-2-planning
 * audit for this migration flagged that gap explicitly as something a
 * real migration must not repeat. The real backend's AuditService is a
 * mandatory, load-bearing part of the API contract (every create/update/
 * delete across every business module calls it) — this file exists so
 * Phase 3+ routes have zero excuse to skip it.
 *
 * Field-for-field mapping, verified directly against
 * src/audit/audit.service.ts's `AuditRecordInput` interface and its
 * `record()` method body:
 *
 *   AuditRecordInput field  →  audit_logs column (this D1 schema)
 *   userId?                 →  user_id       (nullable, matches)
 *   entityType (required)   →  entity_type   (NOT NULL, matches)
 *   entityId?                →  entity_id     (nullable, matches)
 *   action (required)       →  action        (NOT NULL, matches)
 *   oldValues?               →  old_values    (TEXT — JSON.stringify'd;
 *                                               Json? in schema.prisma)
 *   newValues?               →  new_values    (same)
 *   ipAddress?                →  ip_address    (nullable, matches)
 *   userAgent?                →  user_agent    (nullable, matches)
 *   (auto)                  →  id            (new UUID, same as every
 *                                               other table)
 *   (auto)                  →  created_at    (server-set ISO-8601 UTC,
 *                                               same convention as every
 *                                               other timestamp column)
 *
 * oldValues/newValues are typed as Record<string,unknown> here, same as
 * the NestJS AuditRecordInput — this helper does the JSON.stringify
 * itself, so callers pass a plain object exactly as they do today via
 * AuditService.record(), never a pre-serialized string.
 */
export interface AuditRecordInput {
  userId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(db: D1Database, input: AuditRecordInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, old_values, new_values, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      input.userId ?? null,
      input.entityType,
      input.entityId ?? null,
      input.action,
      input.oldValues ? JSON.stringify(input.oldValues) : null,
      input.newValues ? JSON.stringify(input.newValues) : null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      nowIso(),
    )
    .run();
}
