import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireMasterAuth } from '../middleware/auth';
import { ApplicationUserDuplicateError, UserNotFoundError, ok, okPaginated, ValidationError } from '../utils/response';
import { newId, nowIso } from '../utils/id';
import { hashPassword } from '../utils/password';
import { recordAudit } from '../utils/audit';
import { parsePagination } from '../utils/pagination';
import { isValidEmail } from '../utils/format-validators';

/**
 * /api/v1/master/users — ported field-for-field from
 * MasterUsersController/MasterUsersService. Requires a master-scoped JWT
 * only (requireMasterAuth) — no role check layered on top, matching the
 * original exactly (MasterJwtPayload carries no `role`; passing the
 * guard is itself sufficient authorization, same as MasterAuthController
 * needing no RolesGuard).
 *
 * GET delegates to the exact same query logic as GET /users
 * (UsersController/UsersService), reached under the master-JWT boundary
 * instead — the original does this by both controllers calling the same
 * UsersService.list(); this file duplicates that query inline (Workers
 * don't share a DI container the way NestJS providers do), but the
 * query itself — filters, ordering, minimal PublicUser shape — is
 * identical to routes/users.ts's, not a different implementation.
 */
const APPLICATION_ROLES = ['ADMIN', 'EMPLOYEE'];
const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'];

function toPublicUser(row: any) {
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

function generateApplicationUserId(role: string): string {
  const prefix = role === 'ADMIN' ? 'ADM' : 'EMP';
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${prefix}-${suffix}`;
}

/**
 * Case-insensitive-email + plain-mobile duplicate check, scoped to
 * userType='APPLICATION_USER' and excluding the row being updated —
 * matches MasterUsersService.assertNoDuplicate() exactly. This is the
 * pre-check; the actual write below is still guarded by the real UNIQUE
 * constraints as the authoritative source of truth (see the D1 error
 * handling note on the INSERT/UPDATE below).
 */
async function assertNoDuplicate(
  db: D1Database,
  email: string | undefined,
  mobile: string | undefined,
  excludeId?: string,
) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (email) {
    conditions.push('LOWER(email) = LOWER(?)');
    params.push(email);
  }
  if (mobile) {
    conditions.push('mobile = ?');
    params.push(mobile);
  }
  if (conditions.length === 0) return;

  let query = `SELECT id FROM users WHERE user_type = 'APPLICATION_USER' AND (${conditions.join(' OR ')})`;
  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }
  const existing = await db.prepare(query).bind(...params).first();
  if (existing) throw new ApplicationUserDuplicateError();
}

/**
 * D1 error handling note (evidence-based, not blind translation of
 * Prisma's P2002): this exact error message shape —
 * "UNIQUE constraint failed: <table>.<column>" or
 * "UNIQUE constraint failed: index '<name>'" — was directly observed
 * against this project's real local D1 during Phase 1 validation (see
 * that phase's report). Only a message containing "UNIQUE constraint
 * failed" is translated to ApplicationUserDuplicateError here; the users
 * table's only UNIQUE constraints are user_id and the case-insensitive
 * email index, both of which legitimately mean "duplicate application
 * user identity" — matching the exception's own generic message. Any
 * other database error (a genuine unexpected failure) is rethrown
 * as-is, reaching the global error handler as an INTERNAL_ERROR, not
 * silently reported as "duplicate user".
 */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

export const masterUsersRoutes = new Hono<AppEnv>();

masterUsersRoutes.use('/master/users/*', requireMasterAuth);
masterUsersRoutes.use('/master/users', requireMasterAuth);

masterUsersRoutes.get('/master/users', async (c) => {
  const { page, pageSize } = parsePagination(c);
  const role = c.req.query('role');
  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();

  // Matches ListUsersQueryDto's @IsIn() exactly (GET /master/users reuses
  // that same DTO in the real backend — see this file's header comment).
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
    conditions.push('(LOWER(name) LIKE ? OR mobile LIKE ? OR LOWER(email) LIKE ? OR LOWER(user_id) LIKE ?)');
    const term = `%${search.toLowerCase()}%`;
    params.push(term, `%${search}%`, term, term);
  }
  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, user_type, role, name, email, mobile, status FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return c.json(
    okPaginated((rows.results as any[]).map(toPublicUser), {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }),
  );
});

/**
 * POST /api/v1/master/users — matches MasterUsersService.create()
 * exactly, including one deliberately-preserved DTO quirk verified
 * against the actual source: CreateApplicationUserDto's `email` field
 * has @IsEmail() but NO @IsOptional() — every other truly-optional field
 * in that DTO has @IsOptional() explicitly, so this one is validated as
 * required despite being TypeScript-optional. That is reproduced here
 * (email is required on create), not "fixed" — this phase preserves the
 * real backend's actual behavior, not what it was probably intended to
 * be. `mobile`/`name`/`password`/`role` are genuinely required in the
 * original too.
 */
masterUsersRoutes.post('/master/users', async (c) => {
  const master = c.get('masterUser')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ValidationError('Request body must be an object.');
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 150) {
    throw new ValidationError('name is required (1-150 characters).');
  }
  // Phase 9: was previously only checked for non-emptiness — a real gap
  // against CreateApplicationUserDto's `@IsEmail() @MaxLength(255)`
  // (email has no @IsOptional() — see the doc comment above — but its
  // value, once present, must still be a genuinely valid email under
  // 256 characters).
  if (typeof body.email !== 'string' || body.email.length === 0 || body.email.length > 255 || !isValidEmail(body.email)) {
    throw new ValidationError('email is required and must be a valid email address, max 255 characters.');
  }
  if (typeof body.mobile !== 'string' || body.mobile.length === 0 || body.mobile.length > 20) {
    throw new ValidationError('mobile is required (max 20 characters).');
  }
  if (typeof body.password !== 'string' || body.password.length < 8) {
    throw new ValidationError('password must be at least 8 characters.');
  }
  if (typeof body.role !== 'string' || !APPLICATION_ROLES.includes(body.role)) {
    throw new ValidationError(`role must be one of ${APPLICATION_ROLES.join(', ')}.`);
  }

  await assertNoDuplicate(c.env.DB, body.email, body.mobile);

  let userId = typeof body.userId === 'string' ? body.userId : undefined;
  if (userId) {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE user_id = ?').bind(userId).first();
    if (existing) throw new ApplicationUserDuplicateError('A user with this userId already exists.');
  } else {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateApplicationUserId(body.role);
      const existing = await c.env.DB.prepare('SELECT id FROM users WHERE user_id = ?').bind(candidate).first();
      if (!existing) {
        userId = candidate;
        break;
      }
    }
    if (!userId) throw new Error('Failed to generate a unique userId after several attempts.');
  }

  const passwordHash = await hashPassword(body.password);
  const id = newId();
  const now = nowIso();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (
        id, user_type, user_id, role, password_hash, name, email, mobile, alternate_mobile,
        address, city, state, pincode, status, created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'APPLICATION_USER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        userId,
        body.role,
        passwordHash,
        body.name,
        body.email,
        body.mobile,
        body.alternateMobile ?? null,
        body.address ?? null,
        body.city ?? null,
        body.state ?? null,
        body.pincode ?? null,
        now,
        now,
        master.sub,
        master.sub,
      )
      .run();
  } catch (err) {
    // Protects against the check-then-insert race the pre-check above
    // narrows but can't close alone — same reasoning as
    // MasterUsersService.create()'s P2002 catch, adapted for D1's error
    // shape (see isUniqueConstraintError's doc comment).
    if (isUniqueConstraintError(err)) throw new ApplicationUserDuplicateError();
    throw err;
  }

  await recordAudit(c.env.DB, {
    userId: master.sub,
    entityType: 'USER',
    entityId: id,
    action: 'USER_CREATED',
    newValues: { userId, role: body.role, name: body.name, email: body.email ?? null, mobile: body.mobile },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, user_type, role, name, email, mobile, status FROM users WHERE id = ?',
  )
    .bind(id)
    .first();
  return c.json(ok(toPublicUser(row)), 201);
});

/**
 * PATCH /api/v1/master/users/:id — matches MasterUsersService.update()
 * exactly. Scoped to userType='APPLICATION_USER' — a MASTER or CUSTOMER
 * row can never be `existing` here, same structural self-lockout
 * guarantee as the original (a Master Admin cannot edit their own row
 * through this endpoint, by construction). Unlike create(), every field
 * here is genuinely optional (PartialType semantics) — email included.
 */
masterUsersRoutes.patch('/master/users/:id', async (c) => {
  const master = c.get('masterUser')!;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare("SELECT * FROM users WHERE id = ? AND user_type = 'APPLICATION_USER'")
    .bind(id)
    .first<any>();
  if (!existing) throw new UserNotFoundError();

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ValidationError('Request body must be an object.');
  if (body.role !== undefined && !APPLICATION_ROLES.includes(body.role as string)) {
    throw new ValidationError(`role must be one of ${APPLICATION_ROLES.join(', ')}.`);
  }
  if (body.status !== undefined && !USER_STATUSES.includes(body.status as string)) {
    throw new ValidationError(`status must be one of ${USER_STATUSES.join(', ')}.`);
  }
  // Phase 9: UpdateApplicationUserDto is PartialType(CreateApplicationUserDto)
  // minus password/userId — email keeps its @IsEmail() @MaxLength(255)
  // when present (PartialType only relaxes required-ness, not the other
  // constraints). Previously unchecked here entirely.
  if (body.email !== undefined && (typeof body.email !== 'string' || body.email.length > 255 || !isValidEmail(body.email))) {
    throw new ValidationError('email must be a valid email address, max 255 characters.');
  }

  const mobileChanging = body.mobile !== undefined && body.mobile !== existing.mobile;
  const emailChanging = body.email !== undefined && body.email !== existing.email;
  if (mobileChanging || emailChanging) {
    await assertNoDuplicate(
      c.env.DB,
      (body.email as string | undefined) ?? existing.email ?? undefined,
      (body.mobile as string | undefined) ?? existing.mobile ?? undefined,
      id,
    );
  }

  const oldValues = {
    name: existing.name,
    email: existing.email,
    mobile: existing.mobile,
    alternateMobile: existing.alternate_mobile,
    address: existing.address,
    city: existing.city,
    state: existing.state,
    pincode: existing.pincode,
    role: existing.role,
    status: existing.status,
  };

  const fields: string[] = [];
  const params: unknown[] = [];
  const setIfPresent = (key: string, column: string) => {
    if (body[key] !== undefined) {
      fields.push(`${column} = ?`);
      params.push(body[key]);
    }
  };
  setIfPresent('name', 'name');
  setIfPresent('email', 'email');
  setIfPresent('mobile', 'mobile');
  setIfPresent('alternateMobile', 'alternate_mobile');
  setIfPresent('address', 'address');
  setIfPresent('city', 'city');
  setIfPresent('state', 'state');
  setIfPresent('pincode', 'pincode');
  setIfPresent('role', 'role');
  setIfPresent('status', 'status');
  fields.push('updated_at = ?', 'updated_by = ?');
  params.push(nowIso(), master.sub);

  try {
    await c.env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...params, id)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ApplicationUserDuplicateError();
    throw err;
  }

  await recordAudit(c.env.DB, {
    userId: master.sub,
    entityType: 'USER',
    entityId: id,
    action: 'USER_UPDATED',
    oldValues,
    newValues: { ...body },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, user_type, role, name, email, mobile, status FROM users WHERE id = ?',
  )
    .bind(id)
    .first();
  return c.json(ok(toPublicUser(row)));
});
