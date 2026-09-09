import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import { ForbiddenRoleError, FollowUpNotFoundError, InquiryNotFoundError, ok, ValidationError } from '../utils/response';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { recordAudit } from '../utils/audit';
import { getTodayRangeUtc } from '../utils/today-range';
import { isValidIso8601 } from '../utils/format-validators';

/**
 * /api/v1/inquiries/:inquiryId/follow-ups + /api/v1/follow-ups/today —
 * ported field-for-field from FollowUpsController/TodayFollowUpsController/
 * FollowUpsService. Source of truth verified by direct read this phase:
 * follow-ups.controller.ts, today-follow-ups.controller.ts,
 * follow-ups.service.ts, follow-up.mapper.ts, today-range.util.ts,
 * create/update/list-today-follow-ups-query DTOs.
 *
 * Authorization for create()/update() is a plain read-then-write check
 * against the parent inquiry's live assigned_to_user_id (see
 * assertCanModifyParentInquiry below) — NOT the TOCTOU-safe conditional-
 * write pattern used in routes/inquiries.ts. This is intentional and
 * verified against the real FollowUpsService: unlike InquiriesService's
 * applyInquiryWrite(), FollowUpsService has no equivalent conditional-
 * write helper — its create()/update() both do a plain ownership read
 * followed by an unconditional Prisma write. Reproducing the TOCTOU-safe
 * pattern here anyway would be "improving" behavior beyond what the real
 * backend actually does, which this phase's instructions explicitly
 * forbid ("do not accidentally improve validation... match the current
 * backend").
 */

const FOLLOW_UP_STATUSES = ['PENDING', 'COMPLETED'];

export interface FollowUpRow {
  id: string;
  inquiry_id: string;
  scheduled_at: string;
  status: string;
  notes: string | null;
  reminder_enabled: number;
  created_at: string;
  updated_at: string;
}

export const FOLLOW_UP_COLUMNS = 'id, inquiry_id, scheduled_at, status, notes, reminder_enabled, created_at, updated_at';

export function toPublicFollowUp(row: FollowUpRow) {
  return {
    id: row.id,
    inquiryId: row.inquiry_id,
    scheduledAt: row.scheduled_at,
    status: row.status,
    notes: row.notes,
    reminderEnabled: Boolean(row.reminder_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Phase 9: `scheduledAt` format validation now uses the real `validator`
// package's isISO8601() (see utils/format-validators.ts) — byte-perfect
// parity with class-validator's bare @IsISO8601() (no `strict` option is
// passed in create-follow-up.dto.ts, confirmed by direct read — so,
// notably, the real backend does NOT reject impossible calendar dates
// like 2026-02-30, and DOES accept ISO week-dates ("2026-W36-1") and
// ordinal dates ("2026-248"), formats the previous hand-written regex
// here incorrectly rejected).
//
// Known, deliberately accepted difference: the real FollowUpsService
// converts the validated string via `new Date(dto.scheduledAt)` before
// writing to a typed Postgres DateTime column — for the rare
// validator.js-valid-but-JS-Date-unparseable formats above (week-dates,
// ordinal dates), that conversion produces an Invalid Date, which Prisma
// would reject with a runtime error the real backend never turns into a
// clean 400. D1 stores `scheduled_at` as plain TEXT (Phase 1 schema) and
// this Worker never re-parses it through `new Date()` before storing —
// so for that specific rare edge case the Worker is more lenient (it
// simply stores the string) where the real backend would likely 500.
// Not fixed: reproducing a crash for parity would be a regression, not
// a compatibility improvement — see the Phase 9 report's Known
// Differences section.
interface FollowUpInput {
  scheduledAt?: string;
  status?: string;
  notes?: string;
  reminderEnabled?: boolean;
}

function parseFollowUpBody(body: unknown, requireScheduledAt: boolean): FollowUpInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;
  const result: FollowUpInput = {};

  if (b.scheduledAt !== undefined || requireScheduledAt) {
    if (typeof b.scheduledAt !== 'string' || !isValidIso8601(b.scheduledAt)) {
      throw new ValidationError('scheduledAt is required and must be an ISO-8601 date-time.');
    }
    result.scheduledAt = b.scheduledAt;
  }
  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !FOLLOW_UP_STATUSES.includes(b.status)) {
      throw new ValidationError(`status must be one of ${FOLLOW_UP_STATUSES.join(', ')}.`);
    }
    result.status = b.status;
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== 'string') throw new ValidationError('notes must be a string.');
    result.notes = b.notes;
  }
  if (b.reminderEnabled !== undefined) {
    if (typeof b.reminderEnabled !== 'boolean') throw new ValidationError('reminderEnabled must be a boolean.');
    result.reminderEnabled = b.reminderEnabled;
  }

  return result;
}

interface Actor {
  userId: string;
  role?: 'ADMIN' | 'EMPLOYEE';
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertInquiryExists(db: D1Database, inquiryId: string): Promise<{ assigned_to_user_id: string | null }> {
  const inquiry = await db.prepare('SELECT assigned_to_user_id FROM inquiries WHERE id = ?').bind(inquiryId).first<{
    assigned_to_user_id: string | null;
  }>();
  if (!inquiry) throw new InquiryNotFoundError();
  return inquiry;
}

/**
 * Mirrors InquiriesService's assertCanModifyInquiry() rule exactly,
 * applied to the follow-up's *parent inquiry* (a follow-up has no
 * assignment of its own). Deliberately NOT used by list() (no ownership
 * restriction) or delete() (Phase 22B's unrestricted ADMIN+EMPLOYEE
 * delete, unchanged) — matches the real FollowUpsService precisely.
 */
function assertCanModifyParentInquiry(inquiry: { assigned_to_user_id: string | null }, actor: Actor): void {
  if (actor.role === 'EMPLOYEE' && inquiry.assigned_to_user_id !== actor.userId) {
    throw new ForbiddenRoleError('You can only create or edit follow-ups for inquiries currently assigned to you.');
  }
}

export const followUpsRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;

followUpsRoutes.get('/inquiries/:inquiryId/follow-ups', ...staff, async (c) => {
  const inquiryId = c.req.param('inquiryId');
  if (!isValidUuid(inquiryId)) throw new ValidationError('Validation failed (uuid is expected)');

  await assertInquiryExists(c.env.DB, inquiryId);

  const rows = await c.env.DB.prepare(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE inquiry_id = ? ORDER BY scheduled_at ASC`,
  )
    .bind(inquiryId)
    .all<FollowUpRow>();

  return c.json(ok((rows.results ?? []).map(toPublicFollowUp)));
});

followUpsRoutes.post('/inquiries/:inquiryId/follow-ups', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const inquiryId = c.req.param('inquiryId');
  if (!isValidUuid(inquiryId)) throw new ValidationError('Validation failed (uuid is expected)');

  const inquiry = await assertInquiryExists(c.env.DB, inquiryId);
  assertCanModifyParentInquiry(inquiry, actor);

  const input = parseFollowUpBody(await c.req.json().catch(() => null), true);
  const id = newId();
  const now = nowIso();

  await c.env.DB.prepare(
    `INSERT INTO follow_ups (id, inquiry_id, scheduled_at, status, notes, reminder_enabled, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      inquiryId,
      input.scheduledAt,
      input.status ?? 'PENDING',
      input.notes ?? null,
      input.reminderEnabled ? 1 : 0,
      now,
      now,
      actor.userId,
      actor.userId,
    )
    .run();

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'FOLLOW_UP',
    entityId: id,
    action: 'FOLLOW_UP_CREATED',
    newValues: { inquiryId, ...input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE id = ?`).bind(id).first<FollowUpRow>();
  return c.json(ok(toPublicFollowUp(row!)), 201);
});

followUpsRoutes.patch('/inquiries/:inquiryId/follow-ups/:followUpId', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const inquiryId = c.req.param('inquiryId');
  const followUpId = c.req.param('followUpId');
  if (!isValidUuid(inquiryId) || !isValidUuid(followUpId)) {
    throw new ValidationError('Validation failed (uuid is expected)');
  }

  // Scoped by both ids together — a followUpId from a different inquiry
  // must not be editable just by knowing its UUID (matches the real
  // service's findFirst({ id, inquiryId }) exactly).
  const existing = await c.env.DB.prepare(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE id = ? AND inquiry_id = ?`,
  )
    .bind(followUpId, inquiryId)
    .first<FollowUpRow>();
  if (!existing) throw new FollowUpNotFoundError();

  const inquiry = await c.env.DB.prepare('SELECT assigned_to_user_id FROM inquiries WHERE id = ?').bind(inquiryId).first<{
    assigned_to_user_id: string | null;
  }>();
  assertCanModifyParentInquiry(inquiry ?? { assigned_to_user_id: null }, actor);

  const input = parseFollowUpBody(await c.req.json().catch(() => null), false);

  const oldValues = {
    scheduledAt: existing.scheduled_at,
    status: existing.status,
    notes: existing.notes,
    reminderEnabled: Boolean(existing.reminder_enabled),
  };

  // Phase 41H — a follow-up's reminder is one-time per *schedule*, not
  // permanently one-time for the row's whole lifetime: once
  // reminder_sent_at is set by the cron sweep (scheduled/follow-up-
  // reminders.ts), that gate (reminder_sent_at IS NULL) permanently
  // excludes the row from ever being eligible again — even after a
  // genuine reschedule or turning the reminder back on — unless it's
  // explicitly re-armed here. Compared against the already-fetched
  // `existing` row (not merely "was this field present in the request
  // body"), so a client that resends an unchanged scheduledAt/
  // reminderEnabled value alongside an unrelated field (e.g. notes)
  // never triggers an unintended re-arm.
  const isRescheduling =
    input.scheduledAt !== undefined && input.scheduledAt !== existing.scheduled_at;
  const isReminderBeingReEnabled = input.reminderEnabled === true && !existing.reminder_enabled;
  const shouldRearmReminder = isRescheduling || isReminderBeingReEnabled;

  const fields: string[] = [];
  const params: unknown[] = [];
  if (input.scheduledAt !== undefined) {
    fields.push('scheduled_at = ?');
    params.push(input.scheduledAt);
  }
  if (input.status !== undefined) {
    fields.push('status = ?');
    params.push(input.status);
  }
  if (input.notes !== undefined) {
    fields.push('notes = ?');
    params.push(input.notes);
  }
  if (input.reminderEnabled !== undefined) {
    fields.push('reminder_enabled = ?');
    params.push(input.reminderEnabled ? 1 : 0);
  }
  if (shouldRearmReminder) {
    // NULL is a literal, not user input — no bound parameter needed.
    fields.push('reminder_sent_at = NULL');
  }
  fields.push('updated_at = ?', 'updated_by = ?');
  params.push(nowIso(), actor.userId);

  await c.env.DB.prepare(`UPDATE follow_ups SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...params, followUpId)
    .run();

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'FOLLOW_UP',
    entityId: followUpId,
    action: 'FOLLOW_UP_UPDATED',
    oldValues,
    newValues: { ...input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE id = ?`).bind(followUpId).first<FollowUpRow>();
  return c.json(ok(toPublicFollowUp(row!)));
});

/**
 * DELETE /inquiries/:inquiryId/follow-ups/:followUpId (Phase 22B in the
 * real backend) — ADMIN and EMPLOYEE both allowed, unconditionally (no
 * ownership restriction — verified: FollowUpsController.remove() has no
 * @Roles override and FollowUpsService.delete() never calls
 * assertCanModifyParentInquiry()). The audit write and the row delete are
 * batched together (D1's atomic-array equivalent of the real service's
 * $transaction wrapping tx.auditLog.create() + tx.followUp.delete()) —
 * matching its own doc comment: "a follow-up must never be removed
 * without its audit trail, and an audit trail must never claim a
 * deletion that didn't happen."
 */
followUpsRoutes.delete('/inquiries/:inquiryId/follow-ups/:followUpId', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const inquiryId = c.req.param('inquiryId');
  const followUpId = c.req.param('followUpId');
  if (!isValidUuid(inquiryId) || !isValidUuid(followUpId)) {
    throw new ValidationError('Validation failed (uuid is expected)');
  }

  await assertInquiryExists(c.env.DB, inquiryId);

  const existing = await c.env.DB.prepare(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE id = ? AND inquiry_id = ?`,
  )
    .bind(followUpId, inquiryId)
    .first<FollowUpRow>();
  if (!existing) throw new FollowUpNotFoundError();

  const oldValues = JSON.stringify({
    id: existing.id,
    inquiryId: existing.inquiry_id,
    scheduledAt: existing.scheduled_at,
    status: existing.status,
    notes: existing.notes,
    reminderEnabled: Boolean(existing.reminder_enabled),
  });

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, old_values, new_values, ip_address, user_agent, created_at)
       VALUES (?, ?, 'FOLLOW_UP', ?, 'FOLLOW_UP_DELETED', ?, NULL, ?, ?, ?)`,
    ).bind(newId(), actor.userId, existing.id, oldValues, actor.ipAddress ?? null, actor.userAgent ?? null, nowIso()),
    c.env.DB.prepare('DELETE FROM follow_ups WHERE id = ?').bind(followUpId),
  ]);

  return c.body(null, 204);
});

// --- today's follow-ups -------------------------------------------------------

/**
 * GET /api/v1/follow-ups/today — a separate top-level route (not nested
 * under an inquiry), same reasoning as PropertiesController/
 * PublicPropertiesController: a different route prefix sharing the same
 * underlying data, split at the controller level in the real backend,
 * kept as a distinct route registration here rather than folded into the
 * nested follow-up routes above. No pagination (matches
 * ListTodayFollowUpsQueryDto — "today" is a naturally small, bounded set).
 */
followUpsRoutes.get('/follow-ups/today', ...staff, async (c) => {
  const status = c.req.query('status');
  if (status && !FOLLOW_UP_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${FOLLOW_UP_STATUSES.join(', ')}.`);
  }

  const { start, end } = getTodayRangeUtc();

  const conditions = ['f.scheduled_at >= ?', 'f.scheduled_at < ?'];
  const params: unknown[] = [start, end];
  if (status) {
    conditions.push('f.status = ?');
    params.push(status);
  }

  const rows = await c.env.DB.prepare(
    `SELECT ${FOLLOW_UP_COLUMNS.split(', ')
      .map((col) => `f.${col}`)
      .join(', ')},
            i.inquiry_number, i.status AS inquiry_status, cu.id AS customer_id, cu.name AS customer_name
     FROM follow_ups f
     JOIN inquiries i ON i.id = f.inquiry_id
     LEFT JOIN users cu ON cu.id = i.customer_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.scheduled_at ASC`,
  )
    .bind(...params)
    .all<
      FollowUpRow & {
        inquiry_number: string;
        inquiry_status: string;
        customer_id: string | null;
        customer_name: string | null;
      }
    >();

  const data = (rows.results ?? []).map((row) => ({
    ...toPublicFollowUp(row),
    inquiry: {
      id: row.inquiry_id,
      inquiryNumber: row.inquiry_number,
      status: row.inquiry_status,
      customer: row.customer_id ? { id: row.customer_id, name: row.customer_name ?? '' } : null,
    },
  }));

  return c.json(ok(data));
});
