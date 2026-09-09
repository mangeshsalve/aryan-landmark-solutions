import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import { NotificationNotFoundError, ok, okPaginated, ValidationError } from '../utils/response';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { parsePagination } from '../utils/pagination';

/**
 * /api/v1/notifications — ported field-for-field from
 * NotificationsController/NotificationsService. Source of truth verified
 * by direct read this phase: notifications.controller.ts,
 * notifications.service.ts, notification.mapper.ts,
 * list-notifications-query.dto.ts (+ its regression spec),
 * update-notification.dto.ts, notifications.module.ts,
 * notifications.service.spec.ts, and app.exception.ts's
 * NotificationNotFoundException.
 *
 * GET + PATCH only — there is no POST route. Notifications are always
 * system-generated as a side effect of a real business action (currently
 * only inquiry assignment — see routes/inquiries.ts's
 * createInquiryAssignedNotification), never created directly by a
 * client, matching NotificationsController exactly (its class-level doc
 * comment states this explicitly). Every read/write is scoped to the
 * calling user's own notifications via the verified JWT (`sub`) — there
 * is no "list anyone's notifications" capability, and `userId` is
 * deliberately never exposed in the response (redundant once already
 * scoped to the caller).
 *
 * No audit logging exists for notification operations in the real
 * backend (verified: NotificationsService has no AuditService dependency
 * at all) — none is added here either, per this phase's explicit
 * "do not assume audited" instruction.
 */

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  is_read: number;
  read_at: string | null;
  created_at: string;
}

const NOTIFICATION_COLUMNS = 'id, user_id, type, title, message, entity_type, entity_id, is_read, read_at, created_at';

/** Matches notification.mapper.ts's toPublicNotification() exactly — userId is deliberately never exposed. */
function toPublicNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    isRead: Boolean(row.is_read),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * D1 equivalent of NotificationsService.create() — exported for reuse by
 * routes/inquiries.ts, the only current caller (matching the real
 * backend: create() is never exposed over HTTP, only called internally
 * by other services). Same field mapping, same defaults (entityType/
 * entityId null when omitted, isRead/readAt at their D1 schema defaults
 * of 0/NULL).
 *
 * Phase 41C: now returns the generated id (previously void). Every
 * existing caller already only `await`s this without using a return
 * value, so this is additive/non-breaking — the id is needed so
 * routes/inquiries.ts can include `notificationId` in the FCM push data
 * payload without a second, redundant row lookup.
 */
export async function createNotification(db: D1Database, input: CreateNotificationInput): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, message, entity_type, entity_id, is_read, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    )
    .bind(id, input.userId, input.type, input.title, input.message, input.entityType ?? null, input.entityId ?? null, nowIso())
    .run();
  return id;
}

export const notificationsRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;

notificationsRoutes.get('/notifications', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const { page, pageSize } = parsePagination(c);

  // Matches ListNotificationsQueryDto's isRead coercion exactly: only the
  // literal strings "true"/"false" are recognized; anything else present
  // is a validation error (this hand-written parser was never subject to
  // the enableImplicitConversion pitfall the real DTO's regression test
  // documents — it never applies a naive Boolean(value) coercion — but
  // it must still resolve to the same three outcomes: true / false /
  // "no filter" for an absent param).
  const isReadParam = c.req.query('isRead');
  let isRead: boolean | undefined;
  if (isReadParam === 'true') isRead = true;
  else if (isReadParam === 'false') isRead = false;
  else if (isReadParam !== undefined) throw new ValidationError('isRead must be "true" or "false".');

  const conditions = ['user_id = ?'];
  const params: unknown[] = [applicationUser.sub];
  if (isRead !== undefined) {
    conditions.push('is_read = ?');
    params.push(isRead ? 1 : 0);
  }
  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<NotificationRow>();

  return c.json(
    okPaginated((rows.results ?? []).map(toPublicNotification), {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }),
  );
});

notificationsRoutes.patch('/notifications/:id', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('id');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  // Scoped by both id and userId together — a notification id belonging
  // to another user must not be readable/markable just by knowing its
  // UUID (matches NotificationsService.update()'s findFirst({id, userId})
  // exactly — a cross-user id resolves to 404, never 403, so nothing
  // about the other user's notification is leaked).
  const existing = await c.env.DB.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, applicationUser.sub)
    .first<NotificationRow>();
  if (!existing) throw new NotificationNotFoundError();

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body !== null && body.isRead !== undefined && typeof body.isRead !== 'boolean') {
    throw new ValidationError('isRead must be a boolean.');
  }
  const dtoIsRead = body && typeof body.isRead === 'boolean' ? body.isRead : undefined;

  // Matches NotificationsService.update()'s exact transition logic:
  // nextIsRead defaults to the existing value (an omitted isRead is a
  // no-op re-save, not an error); marking read for the first time stamps
  // readAt with now(); marking an already-read notification read again
  // leaves its original readAt untouched (no timestamp overwrite);
  // unmarking (isRead: false) always clears readAt to null.
  const nextIsRead = dtoIsRead ?? Boolean(existing.is_read);
  const nextReadAt = nextIsRead ? (existing.is_read ? existing.read_at : nowIso()) : null;

  await c.env.DB.prepare('UPDATE notifications SET is_read = ?, read_at = ? WHERE id = ?')
    .bind(nextIsRead ? 1 : 0, nextReadAt, id)
    .run();

  const row = await c.env.DB.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?`).bind(id).first<NotificationRow>();
  return c.json(ok(toPublicNotification(row!)));
});

// --- device tokens (Phase 41C — FCM push registration) ---------------------
//
// `user_id` always comes from the verified JWT (`applicationUser.sub`),
// exactly like every scoped query elsewhere in this file — never from
// the request body, so one application user can never register or
// deactivate a token on another's behalf. The FCM registration token
// itself is write-only from the API's perspective: it is accepted on
// register/deactivate but never present in any response body, matching
// this phase's explicit "never return the token" requirement.

const DEVICE_TOKEN_PLATFORMS = ['ANDROID', 'IOS'] as const;
type DeviceTokenPlatform = (typeof DEVICE_TOKEN_PLATFORMS)[number];

function parseDeviceTokenValue(body: Record<string, unknown> | null): string {
  const token = body?.token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new ValidationError('token is required and must be a non-empty string.');
  }
  return token;
}

notificationsRoutes.post('/notifications/device-token', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const token = parseDeviceTokenValue(body);
  const platform = body?.platform;
  if (typeof platform !== 'string' || !DEVICE_TOKEN_PLATFORMS.includes(platform as DeviceTokenPlatform)) {
    throw new ValidationError('platform is required and must be one of: ANDROID, IOS.');
  }

  const now = nowIso();
  // Upsert keyed on the globally-unique token, not on (user, token): the
  // same physical device may already be registered to a different user
  // (a prior employee's session on a shared/handed-down device) — this
  // single statement both creates a brand-new row and transfers an
  // existing one to the current caller, atomically, with no separate
  // SELECT-then-branch race window.
  await c.env.DB.prepare(
    `INSERT INTO device_tokens (id, user_id, token, platform, is_active, last_used_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       is_active = 1,
       last_used_at = excluded.last_used_at`,
  )
    .bind(newId(), applicationUser.sub, token, platform, now, now)
    .run();

  return c.json(ok({ registered: true }));
});

notificationsRoutes.delete('/notifications/device-token', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const token = parseDeviceTokenValue(body);

  // Scoped by both token and user_id together, same "ownership must be
  // proven, not assumed from the token value alone" principle as the
  // PATCH /notifications/:id route above — a token currently owned by a
  // different user (already transferred away via a later register call)
  // is silently a no-op here, never deactivated out from under its
  // current owner.
  await c.env.DB.prepare(
    'UPDATE device_tokens SET is_active = 0 WHERE token = ? AND user_id = ?',
  )
    .bind(token, applicationUser.sub)
    .run();

  return c.json(ok({ deactivated: true }));
});
