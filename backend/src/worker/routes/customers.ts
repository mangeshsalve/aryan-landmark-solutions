import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import {
  CustomerDuplicateError,
  CustomerHasInquiriesError,
  CustomerNotFoundError,
  ok,
  okPaginated,
  ValidationError,
} from '../utils/response';
import { isForeignKeyConstraintError, isUniqueConstraintError } from '../utils/d1-errors';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { recordAudit } from '../utils/audit';
import { parsePagination } from '../utils/pagination';
import { isValidEmail } from '../utils/format-validators';
import { generateCustomerCode } from '../utils/customer-code';

/**
 * /api/v1/customers — ported field-for-field from CustomersController/
 * CustomersService. Customers are stored in the same `users` table as
 * everyone else, scoped to user_type='CUSTOMER' — never a separate
 * table (there isn't one; see CLAUDE.md's 6-table constraint). Source of
 * truth verified by direct read this phase: customers.controller.ts,
 * customers.service.ts, customer.mapper.ts, create/update/list DTOs.
 */

const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'];
const MAX_CUSTOMER_CODE_ATTEMPTS = 5;

export interface CustomerRow {
  id: string;
  user_type: string;
  name: string;
  email: string | null;
  mobile: string | null;
  alternate_mobile: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  // Phase 39 (#11) — nullable: existing rows predate this column (see
  // migrations/0004_add_customer_code.sql); only newly created customers
  // get one.
  customer_code: string | null;
}

export function toPublicCustomer(row: CustomerRow) {
  return {
    id: row.id,
    userType: row.user_type,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    alternateMobile: row.alternate_mobile,
    address: row.address,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customerCode: row.customer_code,
  };
}

export const CUSTOMER_COLUMNS =
  'id, user_type, name, email, mobile, alternate_mobile, address, city, state, pincode, status, created_at, updated_at, customer_code';

/**
 * Phase 39 (#11) — mirrors resolveInquiryNumber()/resolveCreateCode()'s
 * generate-and-retry pattern exactly (routes/inquiries.ts,
 * routes/properties.ts): no client-specified override (not asked for
 * here, unlike propertyCode), just a fresh generateCustomerCode() per
 * attempt until a non-colliding one is found.
 */
async function resolveCustomerCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < MAX_CUSTOMER_CODE_ATTEMPTS; attempt++) {
    const candidate = generateCustomerCode();
    const existing = await db.prepare('SELECT id FROM users WHERE customer_code = ?').bind(candidate).first();
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique customer code after several attempts.');
}

/**
 * Matches CreateCustomerDto exactly: name required (1-150), email
 * optional (@IsEmail, max 255), mobile/alternateMobile optional (max
 * 20), address optional (no max), city/state optional (max 100), pincode
 * optional (max 10). Phase 9: email format checked via the real
 * `validator` package (see utils/format-validators.ts) — byte-perfect
 * parity with class-validator's @IsEmail().
 */

interface CustomerInput {
  name?: string;
  email?: string;
  mobile?: string;
  alternateMobile?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

function parseCustomerBody(body: unknown, requireName: boolean): CustomerInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;
  const result: CustomerInput = {};

  if (b.name !== undefined || requireName) {
    if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 150) {
      throw new ValidationError('name is required (1-150 characters).');
    }
    result.name = b.name;
  }
  if (b.email !== undefined) {
    if (typeof b.email !== 'string' || b.email.length > 255 || !isValidEmail(b.email)) {
      throw new ValidationError('email must be a valid email address, max 255 characters.');
    }
    result.email = b.email;
  }
  if (b.mobile !== undefined) {
    if (typeof b.mobile !== 'string' || b.mobile.length > 20) {
      throw new ValidationError('mobile must be a string, max 20 characters.');
    }
    result.mobile = b.mobile;
  }
  if (b.alternateMobile !== undefined) {
    if (typeof b.alternateMobile !== 'string' || b.alternateMobile.length > 20) {
      throw new ValidationError('alternateMobile must be a string, max 20 characters.');
    }
    result.alternateMobile = b.alternateMobile;
  }
  if (b.address !== undefined) {
    if (typeof b.address !== 'string') throw new ValidationError('address must be a string.');
    result.address = b.address;
  }
  if (b.city !== undefined) {
    if (typeof b.city !== 'string' || b.city.length > 100) {
      throw new ValidationError('city must be a string, max 100 characters.');
    }
    result.city = b.city;
  }
  if (b.state !== undefined) {
    if (typeof b.state !== 'string' || b.state.length > 100) {
      throw new ValidationError('state must be a string, max 100 characters.');
    }
    result.state = b.state;
  }
  if (b.pincode !== undefined) {
    if (typeof b.pincode !== 'string' || b.pincode.length > 10) {
      throw new ValidationError('pincode must be a string, max 10 characters.');
    }
    result.pincode = b.pincode;
  }
  return result;
}

/** Matches CustomersService.assertNoDuplicate() exactly: mobile plain-match OR email case-insensitive match. */
async function assertNoDuplicate(
  db: D1Database,
  mobile: string | undefined,
  email: string | undefined,
  excludeId?: string,
) {
  if (!mobile && !email) return;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (mobile) {
    conditions.push('mobile = ?');
    params.push(mobile);
  }
  if (email) {
    conditions.push('LOWER(email) = LOWER(?)');
    params.push(email);
  }

  let query = `SELECT id FROM users WHERE user_type = 'CUSTOMER' AND (${conditions.join(' OR ')})`;
  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }
  const existing = await db.prepare(query).bind(...params).first();
  if (existing) throw new CustomerDuplicateError();
}

export const customersRoutes = new Hono<AppEnv>();

// Applied per-route (not via a blanket .use()) so DELETE can require only
// ADMIN without also running the ADMIN-or-EMPLOYEE check redundantly —
// mirrors the controller's class-level @Roles('ADMIN','EMPLOYEE') with a
// per-route @Roles('ADMIN') override on remove().
const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;
const adminOnly = [requireApplicationAuth, requireRoles('ADMIN')] as const;

customersRoutes.get('/customers', ...staff, async (c) => {
  const { page, pageSize } = parsePagination(c);
  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();

  if (status && !CUSTOMER_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${CUSTOMER_STATUSES.join(', ')}.`);
  }

  const conditions = ["user_type = 'CUSTOMER'"];
  const params: unknown[] = [];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search && search.length > 0) {
    // Matches CustomersService.list()'s OR clause exactly: name/email
    // case-insensitive contains, mobile plain (case-sensitive) contains.
    conditions.push('(LOWER(name) LIKE ? OR mobile LIKE ? OR LOWER(email) LIKE ?)');
    const term = `%${search.toLowerCase()}%`;
    params.push(term, `%${search}%`, term);
  }
  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  // Phase 39 (#9) — correlated scalar subqueries, not a LEFT JOIN +
  // GROUP BY: a join here would multiply each customer row once per
  // matching property/inquiry, requiring careful de-duplication just to
  // get back to one row per customer — a subquery per count avoids that
  // entirely and always returns exactly one row per customer, unchanged
  // from today's query shape.
  const rows = await c.env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS},
            (SELECT COUNT(*) FROM properties p WHERE p.owner_customer_id = users.id) AS property_count,
            (SELECT COUNT(*) FROM inquiries i WHERE i.customer_id = users.id AND i.type = 'BUYER') AS buy_inquiry_count,
            (SELECT COUNT(*) FROM inquiries i WHERE i.customer_id = users.id AND i.type = 'SELLER') AS sell_inquiry_count
     FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<CustomerRow & { property_count: number; buy_inquiry_count: number; sell_inquiry_count: number }>();

  const data = (rows.results ?? []).map((row) => ({
    ...toPublicCustomer(row),
    propertyCount: row.property_count,
    buyInquiryCount: row.buy_inquiry_count,
    sellInquiryCount: row.sell_inquiry_count,
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

customersRoutes.get('/customers/:id', ...staff, async (c) => {
  const id = c.req.param('id');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const row = await c.env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM users WHERE id = ? AND user_type = 'CUSTOMER'`,
  )
    .bind(id)
    .first<CustomerRow>();
  if (!row) throw new CustomerNotFoundError();

  return c.json(ok(toPublicCustomer(row)));
});

customersRoutes.post('/customers', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const input = parseCustomerBody(await c.req.json().catch(() => null), true);

  await assertNoDuplicate(c.env.DB, input.mobile, input.email);

  const id = newId();
  const now = nowIso();
  // Phase 39 (#11) — every newly created customer gets a generated
  // business code; existing customers are left at NULL (no backfill).
  const customerCode = await resolveCustomerCode(c.env.DB);

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (
        id, user_type, role, password_hash, user_id, name, email, mobile, alternate_mobile,
        address, city, state, pincode, created_at, updated_at, created_by, updated_by, customer_code
      ) VALUES (?, 'CUSTOMER', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.name,
        input.email ?? null,
        input.mobile ?? null,
        input.alternateMobile ?? null,
        input.address ?? null,
        input.city ?? null,
        input.state ?? null,
        input.pincode ?? null,
        now,
        now,
        applicationUser.sub,
        applicationUser.sub,
        customerCode,
      )
      .run();
  } catch (err) {
    // Narrows the same check-then-insert race the pre-check above can't
    // fully close — mirrors CustomersService.create() relying on
    // assertNoDuplicate() plus the DB's own unique index as the final
    // guard, adapted for D1's error shape (see d1-errors.ts).
    if (isUniqueConstraintError(err)) throw new CustomerDuplicateError();
    throw err;
  }

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'CUSTOMER',
    entityId: id,
    action: 'CUSTOMER_CREATED',
    newValues: { ...input },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<CustomerRow>();
  return c.json(ok(toPublicCustomer(row!)), 201);
});

customersRoutes.patch('/customers/:id', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('id');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM users WHERE id = ? AND user_type = 'CUSTOMER'`,
  )
    .bind(id)
    .first<CustomerRow>();
  if (!existing) throw new CustomerNotFoundError();

  const input = parseCustomerBody(await c.req.json().catch(() => null), false);

  // Only re-check duplicates if mobile/email are actually changing —
  // matches CustomersService.update() exactly (saving a customer's own
  // unchanged record must never trip the duplicate check against itself).
  const mobileChanging = input.mobile !== undefined && input.mobile !== existing.mobile;
  const emailChanging = input.email !== undefined && input.email !== existing.email;
  if (mobileChanging || emailChanging) {
    await assertNoDuplicate(
      c.env.DB,
      input.mobile ?? existing.mobile ?? undefined,
      input.email ?? existing.email ?? undefined,
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
  };

  const fields: string[] = [];
  const params: unknown[] = [];
  const setIfPresent = (key: keyof CustomerInput, column: string) => {
    if (input[key] !== undefined) {
      fields.push(`${column} = ?`);
      params.push(input[key]);
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
  fields.push('updated_at = ?', 'updated_by = ?');
  params.push(nowIso(), applicationUser.sub);

  try {
    await c.env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...params, id)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new CustomerDuplicateError();
    throw err;
  }

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'CUSTOMER',
    entityId: id,
    action: 'CUSTOMER_UPDATED',
    oldValues,
    newValues: { ...input },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<CustomerRow>();
  return c.json(ok(toPublicCustomer(row!)));
});

/**
 * DELETE /customers/:id — ADMIN-only (overrides the class-level
 * ADMIN+EMPLOYEE requireRoles, exactly like the controller's per-route
 * @Roles('ADMIN') override). inquiries.customer_id is ON DELETE RESTRICT
 * in the D1 schema (see migrations/0001_initial_schema.sql) — matches
 * Postgres exactly, so the same FK-violation-to-CustomerHasInquiriesError
 * translation applies, using the evidence-based D1 error message check
 * rather than a Prisma P2003 code.
 */
customersRoutes.delete(
  '/customers/:id',
  ...adminOnly,
  async (c) => {
    const applicationUser = c.get('applicationUser')!;
    const id = c.req.param('id');
    if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

    const existing = await c.env.DB.prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM users WHERE id = ? AND user_type = 'CUSTOMER'`,
    )
      .bind(id)
      .first<CustomerRow>();
    if (!existing) throw new CustomerNotFoundError();

    try {
      await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    } catch (err) {
      if (isForeignKeyConstraintError(err)) throw new CustomerHasInquiriesError();
      throw err;
    }

    await recordAudit(c.env.DB, {
      userId: applicationUser.sub,
      entityType: 'CUSTOMER',
      entityId: id,
      action: 'CUSTOMER_DELETED',
      oldValues: { name: existing.name, email: existing.email, mobile: existing.mobile },
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });

    return c.body(null, 204);
  },
);
