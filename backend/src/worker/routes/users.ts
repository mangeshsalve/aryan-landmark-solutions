import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import { ok, okPaginated, UserNotFoundError, ValidationError } from '../utils/response';
import { isValidUuid, nowIso } from '../utils/id';
import { parsePagination } from '../utils/pagination';
import { recordAudit } from '../utils/audit';

const APPLICATION_ROLES = ['ADMIN', 'EMPLOYEE'];
const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'];

/**
 * GET /api/v1/users — ported field-for-field from UsersController/
 * UsersService. Always scoped to userType='APPLICATION_USER' regardless
 * of other filters (a CUSTOMER or MASTER can never appear here,
 * independent of `status`). Response shape is the MINIMAL PublicUser
 * (id, userId, userType, role, name, email, mobile, status) — verified
 * directly against user.mapper.ts's toPublicUser(), not the fuller shape
 * used in the earlier POC/backend-d1-test (which was wrong — this file
 * corrects that). password_hash is never selected, so it cannot leak.
 */
export const usersRoutes = new Hono<AppEnv>();

usersRoutes.use('/users', requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE'));

usersRoutes.get('/users', async (c) => {
  const { page, pageSize } = parsePagination(c);
  const role = c.req.query('role');
  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();

  // Matches ListUsersQueryDto's @IsIn() exactly — an invalid value is a
  // 400, not a silently-empty result set.
  if (role !== undefined && !APPLICATION_ROLES.includes(role)) {
    throw new ValidationError(`role must be one of ${APPLICATION_ROLES.join(', ')}.`);
  }
  if (status !== undefined && !USER_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${USER_STATUSES.join(', ')}.`);
  }

  const conditions = ["user_type = 'APPLICATION_USER'"];
  const params: unknown[] = [];

  if (role) {
    conditions.push('role = ?');
    params.push(role);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search && search.length > 0) {
    // Matches UsersService.list()'s OR clause exactly: name/mobile/
    // email/userId, name+email case-insensitive (mode: 'insensitive'),
    // mobile a plain (case-sensitive — it's numeric) contains match.
    conditions.push(
      '(LOWER(name) LIKE ? OR mobile LIKE ? OR LOWER(email) LIKE ? OR LOWER(user_id) LIKE ?)',
    );
    const term = `%${search.toLowerCase()}%`;
    params.push(term, `%${search}%`, term, term);
  }

  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, user_type, role, name, email, mobile, status
     FROM users
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  const data = (rows.results as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    userType: row.user_type,
    role: row.role,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
  }));

  return c.json(
    okPaginated(data, {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }),
  );
});

function toPublicUser(row: {
  id: string;
  user_id: string | null;
  user_type: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    userType: row.user_type,
    role: row.role,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
  };
}

/**
 * Matches USER_STATUSES exactly (see this file's top). Strict allow-list
 * of one field on purpose: this endpoint's entire reason to exist is
 * "ADMIN can change an employee's status and nothing else" — any other
 * key in the body is rejected outright, not silently ignored, so a
 * caller that thinks it changed `role`/`email` through here never gets a
 * false impression that it worked.
 */
function parseStatusUpdateBody(body: unknown): { status: string } {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;
  const unexpectedKeys = Object.keys(b).filter((key) => key !== 'status');
  if (unexpectedKeys.length > 0) {
    throw new ValidationError(
      `This endpoint can only update status. Unexpected field(s): ${unexpectedKeys.join(', ')}.`,
    );
  }
  if (typeof b.status !== 'string' || !USER_STATUSES.includes(b.status)) {
    throw new ValidationError(`status must be one of ${USER_STATUSES.join(', ')}.`);
  }
  return { status: b.status };
}

/**
 * PATCH /api/v1/users/:id — Phase 35. ADMIN-only (deliberately NOT
 * 'ADMIN','EMPLOYEE' like GET /users above — an EMPLOYEE must never be
 * able to change anyone's status, including their own). Scoped to
 * user_type='APPLICATION_USER' only — a CUSTOMER or MASTER row can never
 * be reached through this endpoint, same structural guarantee
 * master-users.ts's PATCH already relies on for its own scope. This is
 * intentionally a separate, narrower endpoint from
 * PATCH /master/users/:id — that one (MASTER-only) can still change
 * name/email/mobile/role/etc.; this one (ADMIN-only) can change status
 * only, per this phase's explicit scope.
 *
 * Registered with its own explicit middleware rather than relying on
 * this file's existing `usersRoutes.use('/users', ...)` — that
 * registration matches the literal path '/users' only, not '/users/:id'
 * (Hono does not treat `.use(path, ...)` as a prefix match), the same
 * reason master-users.ts registers both '/master/users' and
 * '/master/users/*' separately.
 */
const adminOnly = [requireApplicationAuth, requireRoles('ADMIN')] as const;

usersRoutes.patch('/users/:id', ...adminOnly, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('id');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM users WHERE id = ? AND user_type = 'APPLICATION_USER'`,
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) throw new UserNotFoundError();

  const input = parseStatusUpdateBody(await c.req.json().catch(() => null));

  await c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .bind(input.status, nowIso(), applicationUser.sub, id)
    .run();

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'USER',
    entityId: id,
    action: 'USER_UPDATED',
    oldValues: { status: existing.status },
    newValues: { status: input.status },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, user_type, role, name, email, mobile, status FROM users WHERE id = ?',
  )
    .bind(id)
    .first<{
      id: string;
      user_id: string | null;
      user_type: string;
      role: string | null;
      name: string;
      email: string | null;
      mobile: string | null;
      status: string;
    }>();
  return c.json(ok(toPublicUser(row!)));
});
