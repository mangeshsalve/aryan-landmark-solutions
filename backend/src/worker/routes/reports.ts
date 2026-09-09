import { Hono } from 'hono';
import type { AppEnv, ApplicationJwtPayload } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import {
  ForbiddenRoleError,
  ok,
  okPaginated,
  UserNotFoundError,
  ValidationError,
} from '../utils/response';
import { isValidUuid } from '../utils/id';
import { isValidDateOnly } from '../utils/format-validators';
import { getDateRangeBoundsUtc, getTodayRangeUtc } from '../utils/today-range';
import { parsePagination } from '../utils/pagination';
import { minorUnitsToRupees } from '../utils/money';
import { PROPERTY_SELECT_WITH_OWNER, type PropertyRow } from './properties';

/**
 * /api/v1/reports — Phase 22. New module, not a port of anything on the
 * NestJS side (Phase 21 discovery confirmed zero report/dashboard/
 * analytics endpoints exist anywhere in the real backend either) — every
 * query here is newly designed, but built strictly from the existing
 * schema, existing authorization primitives (requireApplicationAuth/
 * requireRoles, same as every other module), and existing response
 * envelope (ok()). No new table, column, or index — see the Phase 22
 * report's SQL/Data Design section for exactly which existing indexes
 * each query already benefits from.
 *
 * Authorization, as approved for this phase:
 *  - MASTER: structurally impossible to reach any route below —
 *    requireApplicationAuth verifies only against JWT_ACCESS_SECRET, and
 *    a MASTER-signed token (MASTER_JWT_ACCESS_SECRET) fails that
 *    verification outright (401), exactly like every other staff-only
 *    module. No MASTER-specific check was added or is needed.
 *  - ADMIN: unrestricted — sees global data, may pass any employeeId.
 *  - EMPLOYEE: sees the same global inventory/business counts they
 *    already see today via the existing unrestricted /properties,
 *    /customers, /inquiries list endpoints (see resolveEmployeeScope's
 *    doc comment below for the one place a real restriction is
 *    enforced: the Employee Performance Report's employeeId).
 */

const INQUIRY_TYPES = ['BUYER', 'SELLER'];
const INQUIRY_STATUSES = ['NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const FOLLOW_UP_STATUSES = ['PENDING', 'COMPLETED'];
const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'];
const PROPERTY_STATUSES = ['AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE'];

interface CountRow {
  c: number;
}

function countOf(result: D1Result<unknown> | undefined): number {
  const row = result?.results?.[0] as CountRow | undefined;
  return row?.c ?? 0;
}

/**
 * Shared fromDate/toDate parsing — every report endpoint below uses this
 * exact validation, so "date filtering is clearly defined and
 * implemented consistently" (Phase 22 Part D/I's own requirement) holds
 * across all six endpoints. See utils/format-validators.ts's
 * isValidDateOnly doc comment for why this is a new, stricter validator
 * rather than a reuse of the existing (deliberately lenient) scheduledAt
 * validator.
 */
function parseDateRangeParams(c: { req: { query(name: string): string | undefined } }): {
  fromDate?: string;
  toDate?: string;
} {
  const fromDate = c.req.query('fromDate');
  const toDate = c.req.query('toDate');
  if (fromDate !== undefined && !isValidDateOnly(fromDate)) {
    throw new ValidationError('fromDate must be a valid calendar date in YYYY-MM-DD format.');
  }
  if (toDate !== undefined && !isValidDateOnly(toDate)) {
    throw new ValidationError('toDate must be a valid calendar date in YYYY-MM-DD format.');
  }
  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('fromDate must not be after toDate.');
  }
  return { fromDate, toDate };
}

/**
 * Enforces the one real, phase-approved ownership restriction in this
 * module: an EMPLOYEE may only ever see their own Employee Performance
 * Report row, whether they pass their own id, someone else's id, or omit
 * it entirely (all three collapse to "self"; passing someone else's id
 * is the only case that 403s). ADMIN passes through unrestricted —
 * omitting employeeId means "all employees" to the caller of this
 * function, not enforced here.
 *
 * Deliberately NOT applied to the employeeId filter on /reports/inquiries
 * or /reports/follow-ups — those aggregate breakdowns describe the same
 * inquiry/follow-up rows any staff member can already see in full via
 * the existing unrestricted GET /inquiries and GET /inquiries/:id/
 * follow-ups endpoints, so restricting the filter there would be a new
 * restriction on data that isn't actually hidden today, which Phase 22
 * Part A explicitly warns against ("do not silently introduce ownership
 * restrictions to unrelated existing modules"). Only the Employee
 * Performance Report itself (Part A/F, explicitly named) carries the
 * self-only rule.
 */
function resolveEmployeeScope(
  applicationUser: ApplicationJwtPayload,
  requestedEmployeeId: string | undefined,
): string | undefined {
  if (requestedEmployeeId !== undefined && !isValidUuid(requestedEmployeeId)) {
    throw new ValidationError('employeeId must be a UUID.');
  }
  if (applicationUser.role === 'EMPLOYEE') {
    if (requestedEmployeeId !== undefined && requestedEmployeeId !== applicationUser.sub) {
      throw new ForbiddenRoleError('Employees can only view their own performance report.');
    }
    return applicationUser.sub;
  }
  return requestedEmployeeId;
}

export const reportsRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;

// --- dashboard -----------------------------------------------------------

reportsRoutes.get('/reports/dashboard', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const isEmployee = applicationUser.role === 'EMPLOYEE';
  const { start: todayStart, end: todayEnd } = getTodayRangeUtc();
  const now = new Date().toISOString();

  type Key =
    | 'totalInquiries'
    | 'assignedInquiries'
    | 'unassignedInquiries'
    | 'buyInquiries'
    | 'sellInquiries'
    | 'totalProperties'
    | 'availableProperties'
    | 'totalCustomers'
    | 'todaysFollowUps'
    | 'pendingFollowUps'
    | 'overdueFollowUps';

  const entries: Array<{ key: Key; stmt: D1PreparedStatement }> = [
    { key: 'totalInquiries', stmt: c.env.DB.prepare('SELECT COUNT(*) c FROM inquiries') },
    {
      key: 'assignedInquiries',
      stmt: c.env.DB.prepare(
        'SELECT COUNT(*) c FROM inquiries WHERE assigned_to_user_id IS NOT NULL',
      ),
    },
    {
      key: 'unassignedInquiries',
      stmt: c.env.DB.prepare('SELECT COUNT(*) c FROM inquiries WHERE assigned_to_user_id IS NULL'),
    },
    {
      key: 'buyInquiries',
      stmt: c.env.DB.prepare("SELECT COUNT(*) c FROM inquiries WHERE type = 'BUYER'"),
    },
    {
      key: 'sellInquiries',
      stmt: c.env.DB.prepare("SELECT COUNT(*) c FROM inquiries WHERE type = 'SELLER'"),
    },
    { key: 'totalProperties', stmt: c.env.DB.prepare('SELECT COUNT(*) c FROM properties') },
    {
      key: 'availableProperties',
      stmt: c.env.DB.prepare("SELECT COUNT(*) c FROM properties WHERE status = 'AVAILABLE'"),
    },
    {
      key: 'totalCustomers',
      stmt: c.env.DB.prepare("SELECT COUNT(*) c FROM users WHERE user_type = 'CUSTOMER'"),
    },
  ];

  // Follow-up metrics: global for ADMIN, scoped through the parent
  // inquiry's assigned_to_user_id for EMPLOYEE (Phase 22 Part A/C —
  // follow_ups has no employee column of its own, matching the same
  // join the app already uses for follow-up edit-permission checks).
  if (isEmployee) {
    const selfId = applicationUser.sub;
    entries.push(
      {
        key: 'todaysFollowUps',
        stmt: c.env.DB.prepare(
          `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.scheduled_at >= ? AND f.scheduled_at < ?`,
        ).bind(selfId, todayStart, todayEnd),
      },
      {
        key: 'pendingFollowUps',
        stmt: c.env.DB.prepare(
          `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.status = 'PENDING'`,
        ).bind(selfId),
      },
      {
        key: 'overdueFollowUps',
        stmt: c.env.DB.prepare(
          `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.status = 'PENDING' AND f.scheduled_at < ?`,
        ).bind(selfId, now),
      },
    );
  } else {
    entries.push(
      {
        key: 'todaysFollowUps',
        stmt: c.env.DB.prepare(
          'SELECT COUNT(*) c FROM follow_ups WHERE scheduled_at >= ? AND scheduled_at < ?',
        ).bind(todayStart, todayEnd),
      },
      {
        key: 'pendingFollowUps',
        stmt: c.env.DB.prepare("SELECT COUNT(*) c FROM follow_ups WHERE status = 'PENDING'"),
      },
      {
        key: 'overdueFollowUps',
        stmt: c.env.DB.prepare(
          "SELECT COUNT(*) c FROM follow_ups WHERE status = 'PENDING' AND scheduled_at < ?",
        ).bind(now),
      },
    );
  }

  // One round trip for all eleven counts (D1Database.batch()), not
  // eleven separate requests — matches Phase 22 Part C's explicit
  // "avoid fetching all rows / do not make many separate calls, use
  // batching" instruction.
  const results = await c.env.DB.batch(entries.map((e) => e.stmt));
  const data = {} as Record<Key, number>;
  entries.forEach((entry, i) => {
    data[entry.key] = countOf(results[i]);
  });

  return c.json(ok(data));
});

// --- inquiries -------------------------------------------------------------

interface QueryContext {
  req: { query(name: string): string | undefined };
}

/**
 * Phase 31 — shared by both /reports/inquiries (KPI) and the new
 * /reports/inquiries/records below, so the two can never drift apart:
 * a KPI count and the detail rows behind it are always describing the
 * exact same filtered set, because they're built from the exact same
 * function. Every condition is `i.`-qualified (not just for the new
 * records endpoint's joins — the KPI queries below now alias
 * `FROM inquiries i` too, for an identical reason: this file's own
 * customers-report bug, fixed in Phase 22, showed that an unqualified
 * column becomes genuinely ambiguous the moment any caller of this
 * function joins in `users`/`properties`, both of which also have a
 * `status`/`created_at` column). employeeId filters by
 * assigned_to_user_id, not handled_by_user_id — the same "who owns this
 * inquiry" relationship follow-ups/dashboard scoping already uses.
 * `type` (Phase 31 Part D3) was missing from the KPI endpoint until this
 * phase — added here so KPI and records share the identical filter set
 * this phase's own requirements list names for both.
 */
function parseInquiryReportFilters(c: QueryContext): { conditions: string[]; params: unknown[] } {
  const { fromDate, toDate } = parseDateRangeParams(c);
  const employeeId = c.req.query('employeeId');
  const customerId = c.req.query('customerId');
  const type = c.req.query('type');
  const status = c.req.query('status');

  if (employeeId !== undefined && !isValidUuid(employeeId))
    throw new ValidationError('employeeId must be a UUID.');
  if (customerId !== undefined && !isValidUuid(customerId))
    throw new ValidationError('customerId must be a UUID.');
  if (type !== undefined && !INQUIRY_TYPES.includes(type)) {
    throw new ValidationError(`type must be one of ${INQUIRY_TYPES.join(', ')}.`);
  }
  if (status !== undefined && !INQUIRY_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${INQUIRY_STATUSES.join(', ')}.`);
  }

  const { start, end } = getDateRangeBoundsUtc(fromDate, toDate);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (start) {
    conditions.push('i.created_at >= ?');
    params.push(start);
  }
  if (end) {
    conditions.push('i.created_at < ?');
    params.push(end);
  }
  if (employeeId) {
    conditions.push('i.assigned_to_user_id = ?');
    params.push(employeeId);
  }
  if (customerId) {
    conditions.push('i.customer_id = ?');
    params.push(customerId);
  }
  if (type) {
    conditions.push('i.type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  }
  return { conditions, params };
}

reportsRoutes.get('/reports/inquiries', ...staff, async (c) => {
  const { conditions, params } = parseInquiryReportFilters(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const whereAnd = conditions.length > 0 ? `${where} AND` : 'WHERE';

  const statements = [
    c.env.DB.prepare(`SELECT COUNT(*) c FROM inquiries i ${where}`).bind(...params),
    c.env.DB.prepare(`SELECT i.type t, COUNT(*) c FROM inquiries i ${where} GROUP BY i.type`).bind(
      ...params,
    ),
    c.env.DB.prepare(
      `SELECT i.status s, COUNT(*) c FROM inquiries i ${where} GROUP BY i.status`,
    ).bind(...params),
    c.env.DB.prepare(
      `SELECT COUNT(*) c FROM inquiries i ${whereAnd} i.assigned_to_user_id IS NOT NULL`,
    ).bind(...params),
    c.env.DB.prepare(
      `SELECT COUNT(*) c FROM inquiries i ${whereAnd} i.assigned_to_user_id IS NULL`,
    ).bind(...params),
  ];
  const [totalResult, byTypeResult, byStatusResult, assignedResult, unassignedResult] =
    await c.env.DB.batch(statements);

  const byType: Record<string, number> = Object.fromEntries(INQUIRY_TYPES.map((t) => [t, 0]));
  for (const row of (byTypeResult.results ?? []) as Array<{ t: string | null; c: number }>) {
    if (row.t && byType[row.t] !== undefined) byType[row.t] = row.c;
  }
  const byStatus: Record<string, number> = Object.fromEntries(INQUIRY_STATUSES.map((s) => [s, 0]));
  for (const row of (byStatusResult.results ?? []) as Array<{ s: string; c: number }>) {
    if (byStatus[row.s] !== undefined) byStatus[row.s] = row.c;
  }

  return c.json(
    ok({
      total: countOf(totalResult),
      byType,
      byStatus,
      assigned: countOf(assignedResult),
      unassigned: countOf(unassignedResult),
    }),
  );
});

interface InquiryRecordRow {
  inquiry_number: string;
  type: string | null;
  priority: string;
  status: string;
  city: string | null;
  created_at: string;
  customer_name: string | null;
  property_code: string | null;
  assigned_employee_name: string | null;
}

/**
 * Phase 31 — record-level rows behind the /reports/inquiries KPI, using
 * the identical filter set (parseInquiryReportFilters). One JOIN query,
 * not one lookup per row: customer/property/assignee names are resolved
 * via LEFT JOIN exactly like GET /inquiries (the general list endpoint)
 * already does for customer/handled-by/assigned-to — this reuses that
 * same proven join shape, adding only `properties` for propertyCode,
 * which that endpoint doesn't select today.
 */
reportsRoutes.get('/reports/inquiries/records', ...staff, async (c) => {
  const { conditions, params } = parseInquiryReportFilters(c);
  const { page, pageSize } = parsePagination(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) c FROM inquiries i ${where}`)
    .bind(...params)
    .first<CountRow>();
  const total = totalRow?.c ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT i.inquiry_number, i.type, i.priority, i.status, i.city, i.created_at,
            cu.name AS customer_name, p.property_code AS property_code, ao.name AS assigned_employee_name
     FROM inquiries i
     LEFT JOIN users cu ON cu.id = i.customer_id
     LEFT JOIN properties p ON p.id = i.property_id
     LEFT JOIN users ao ON ao.id = i.assigned_to_user_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<InquiryRecordRow>();

  const data = (rows.results ?? []).map((row) => ({
    inquiryNumber: row.inquiry_number,
    customerName: row.customer_name,
    propertyCode: row.property_code,
    type: row.type,
    priority: row.priority,
    status: row.status,
    assignedEmployeeName: row.assigned_employee_name,
    city: row.city,
    createdAt: row.created_at,
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

// --- follow-ups --------------------------------------------------------

/**
 * Phase 31 — shared by /reports/follow-ups (KPI) and the new
 * /reports/follow-ups/records below. Date range filters against
 * f.scheduled_at, not created_at — unlike every other report in this
 * module, a follow-up's report-relevant date is when it is DUE, not
 * when the row was created (a follow-up scheduled for next week but
 * created today should count toward next week's range, not today's).
 * Deliberately documented here and in OpenAPI since it's a real,
 * reasoned departure from the created_at basis the other reports use.
 */
interface FollowUpReportFilters {
  conditions: string[];
  params: unknown[];
  employeeId?: string;
  status?: string;
}

function parseFollowUpReportFilters(c: QueryContext): FollowUpReportFilters {
  const { fromDate, toDate } = parseDateRangeParams(c);
  const employeeId = c.req.query('employeeId');
  const status = c.req.query('status');

  if (employeeId !== undefined && !isValidUuid(employeeId))
    throw new ValidationError('employeeId must be a UUID.');
  if (status !== undefined && !FOLLOW_UP_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${FOLLOW_UP_STATUSES.join(', ')}.`);
  }

  const { start, end } = getDateRangeBoundsUtc(fromDate, toDate);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (start) {
    conditions.push('f.scheduled_at >= ?');
    params.push(start);
  }
  if (end) {
    conditions.push('f.scheduled_at < ?');
    params.push(end);
  }
  if (employeeId) {
    conditions.push('i.assigned_to_user_id = ?');
    params.push(employeeId);
  }
  if (status) {
    conditions.push('f.status = ?');
    params.push(status);
  }
  return { conditions, params, employeeId, status };
}

reportsRoutes.get('/reports/follow-ups', ...staff, async (c) => {
  const { conditions, params, employeeId, status } = parseFollowUpReportFilters(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const whereAnd = conditions.length > 0 ? `${where} AND` : 'WHERE';
  const base = 'FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id';

  // Today's Follow-ups is always the current IST calendar day,
  // independent of fromDate/toDate (a fixed concept, not a queryable
  // range — letting the date filter also constrain it would silently
  // zero it out whenever "today" falls outside the requested range).
  // employeeId/status still apply, since those describe *whose*/*which*
  // follow-ups are being counted, not *when*.
  const todayConditions: string[] = [];
  const todayParams: unknown[] = [];
  const { start: todayStart, end: todayEnd } = getTodayRangeUtc();
  todayConditions.push('f.scheduled_at >= ?', 'f.scheduled_at < ?');
  todayParams.push(todayStart, todayEnd);
  if (employeeId) {
    todayConditions.push('i.assigned_to_user_id = ?');
    todayParams.push(employeeId);
  }
  if (status) {
    todayConditions.push('f.status = ?');
    todayParams.push(status);
  }

  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(`SELECT COUNT(*) c ${base} ${where}`).bind(...params),
    c.env.DB.prepare(`SELECT COUNT(*) c ${base} ${whereAnd} f.status = 'PENDING'`).bind(...params),
    c.env.DB.prepare(`SELECT COUNT(*) c ${base} ${whereAnd} f.status = 'COMPLETED'`).bind(
      ...params,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) c ${base} ${whereAnd} f.status = 'PENDING' AND f.scheduled_at < ?`,
    ).bind(...params, now),
    c.env.DB.prepare(`SELECT COUNT(*) c ${base} WHERE ${todayConditions.join(' AND ')}`).bind(
      ...todayParams,
    ),
  ];
  const [totalResult, pendingResult, completedResult, overdueResult, todayResult] =
    await c.env.DB.batch(statements);

  return c.json(
    ok({
      total: countOf(totalResult),
      pending: countOf(pendingResult),
      completed: countOf(completedResult),
      overdue: countOf(overdueResult),
      todaysFollowUps: countOf(todayResult),
    }),
  );
});

interface FollowUpRecordRow {
  scheduled_at: string;
  status: string;
  notes: string | null;
  inquiry_number: string;
  customer_name: string | null;
  assigned_employee_name: string | null;
  overdue: number;
}

/**
 * Phase 31 — record-level rows behind the /reports/follow-ups KPI,
 * using the identical filter set (parseFollowUpReportFilters). `overdue`
 * is computed in SQL (status = PENDING AND scheduled_at < now), the same
 * definition the KPI endpoint's own `overdue` count already uses —
 * never a stored column. No direct employee column exists on
 * follow_ups, so the employee name is resolved through the parent
 * inquiry's assigned_to_user_id, the same join the KPI endpoint's own
 * `employeeId` filter already relies on.
 */
reportsRoutes.get('/reports/follow-ups/records', ...staff, async (c) => {
  const { conditions, params } = parseFollowUpReportFilters(c);
  const { page, pageSize } = parsePagination(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const base = 'FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id';
  const now = new Date().toISOString();

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) c ${base} ${where}`)
    .bind(...params)
    .first<CountRow>();
  const total = totalRow?.c ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT f.scheduled_at, f.status, f.notes, i.inquiry_number,
            cu.name AS customer_name, ao.name AS assigned_employee_name,
            CASE WHEN f.status = 'PENDING' AND f.scheduled_at < ? THEN 1 ELSE 0 END AS overdue
     ${base}
     LEFT JOIN users cu ON cu.id = i.customer_id
     LEFT JOIN users ao ON ao.id = i.assigned_to_user_id
     ${where}
     ORDER BY f.scheduled_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(now, ...params, pageSize, (page - 1) * pageSize)
    .all<FollowUpRecordRow>();

  const data = (rows.results ?? []).map((row) => ({
    scheduledAt: row.scheduled_at,
    inquiryNumber: row.inquiry_number,
    customerName: row.customer_name,
    assignedEmployeeName: row.assigned_employee_name,
    status: row.status,
    overdue: Boolean(row.overdue),
    notes: row.notes,
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

// --- employees -----------------------------------------------------------

interface EmployeeMetricsRow {
  id: string;
  name: string;
  assignedInquiries: number;
  pendingFollowUps: number;
  completedFollowUps: number;
  overdueFollowUps: number;
  assignmentsInPeriod: number;
}

reportsRoutes.get('/reports/employees', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const { fromDate, toDate } = parseDateRangeParams(c);
  const requestedEmployeeId = c.req.query('employeeId');
  const employeeId = resolveEmployeeScope(applicationUser, requestedEmployeeId);

  const { start, end } = getDateRangeBoundsUtc(fromDate, toDate);
  const now = new Date().toISOString();

  // The employee set to report on: exactly one (self-scoped EMPLOYEE, or
  // ADMIN targeting a specific id) or every EMPLOYEE role user (ADMIN,
  // no employeeId). Validated to exist first — a stale/wrong id should
  // 404, not silently return an all-zero row.
  let employeeRows: Array<{ id: string; name: string }>;
  if (employeeId) {
    const row = await c.env.DB.prepare(
      "SELECT id, name FROM users WHERE id = ? AND user_type = 'APPLICATION_USER'",
    )
      .bind(employeeId)
      .first<{ id: string; name: string }>();
    if (!row) throw new UserNotFoundError('Referenced employee not found.');
    employeeRows = [row];
  } else {
    const rows = await c.env.DB.prepare(
      "SELECT id, name FROM users WHERE user_type = 'APPLICATION_USER' AND role = 'EMPLOYEE' ORDER BY name ASC",
    ).all<{ id: string; name: string }>();
    employeeRows = rows.results ?? [];
  }

  if (employeeRows.length === 0) {
    return c.json(ok<EmployeeMetricsRow[]>([]));
  }

  // One batch per employee (4 follow-up/inquiry counts + 1 assignment-
  // history count), all employees' batches combined into a single
  // c.env.DB.batch() call — still one round trip regardless of how many
  // employees are being reported on.
  const perEmployeeStatements: D1PreparedStatement[] = [];
  for (const employee of employeeRows) {
    perEmployeeStatements.push(
      c.env.DB.prepare('SELECT COUNT(*) c FROM inquiries WHERE assigned_to_user_id = ?').bind(
        employee.id,
      ),
      c.env.DB.prepare(
        `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.status = 'PENDING'
           ${start ? 'AND f.scheduled_at >= ?' : ''} ${end ? 'AND f.scheduled_at < ?' : ''}`,
      ).bind(employee.id, ...[start, end].filter((v): v is string => Boolean(v))),
      c.env.DB.prepare(
        `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.status = 'COMPLETED'
           ${start ? 'AND f.scheduled_at >= ?' : ''} ${end ? 'AND f.scheduled_at < ?' : ''}`,
      ).bind(employee.id, ...[start, end].filter((v): v is string => Boolean(v))),
      c.env.DB.prepare(
        `SELECT COUNT(*) c FROM follow_ups f JOIN inquiries i ON i.id = f.inquiry_id
           WHERE i.assigned_to_user_id = ? AND f.status = 'PENDING' AND f.scheduled_at < ?
           ${start ? 'AND f.scheduled_at >= ?' : ''} ${end ? 'AND f.scheduled_at < ?' : ''}`,
      ).bind(employee.id, now, ...[start, end].filter((v): v is string => Boolean(v))),
      // Genuine assignment history (Part F's explicit requirement) —
      // inquiry_assignments.assigned_at, never the live
      // inquiries.assigned_to_user_id snapshot, so this correctly
      // answers "how many assignments happened in this period" even
      // for an inquiry that has since been reassigned again.
      c.env.DB.prepare(
        `SELECT COUNT(*) c FROM inquiry_assignments
           WHERE assigned_to_user_id = ?
           ${start ? 'AND assigned_at >= ?' : ''} ${end ? 'AND assigned_at < ?' : ''}`,
      ).bind(employee.id, ...[start, end].filter((v): v is string => Boolean(v))),
    );
  }

  const results = await c.env.DB.batch(perEmployeeStatements);

  const data: EmployeeMetricsRow[] = employeeRows.map((employee, i) => {
    const base = i * 5;
    return {
      id: employee.id,
      name: employee.name,
      assignedInquiries: countOf(results[base]),
      pendingFollowUps: countOf(results[base + 1]),
      completedFollowUps: countOf(results[base + 2]),
      overdueFollowUps: countOf(results[base + 3]),
      assignmentsInPeriod: countOf(results[base + 4]),
    };
  });

  return c.json(ok(data));
});

// --- properties --------------------------------------------------------

/**
 * Phase 31 — shared by /reports/properties (KPI) and the new
 * /reports/properties/records below. `p.`-qualified throughout (the KPI
 * queries below now alias `FROM properties p` too, not just the records
 * endpoint's PROPERTY_SELECT_WITH_OWNER join) — `users`, joined in by
 * the records endpoint's owner lookup, also has `status`/`city`/
 * `created_at` columns, the same ambiguity class already fixed once in
 * this file's customers-report query (Phase 22).
 */
function parsePropertyReportFilters(c: QueryContext): { conditions: string[]; params: unknown[] } {
  const { fromDate, toDate } = parseDateRangeParams(c);
  const category = c.req.query('category');
  const status = c.req.query('status');
  const city = c.req.query('city');
  const ownerCustomerId = c.req.query('ownerCustomerId');

  if (category !== undefined && !PROPERTY_CATEGORIES.includes(category)) {
    throw new ValidationError(`category must be one of ${PROPERTY_CATEGORIES.join(', ')}.`);
  }
  if (status !== undefined && !PROPERTY_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${PROPERTY_STATUSES.join(', ')}.`);
  }
  if (ownerCustomerId !== undefined && !isValidUuid(ownerCustomerId)) {
    throw new ValidationError('ownerCustomerId must be a UUID.');
  }

  const { start, end } = getDateRangeBoundsUtc(fromDate, toDate);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (start) {
    conditions.push('p.created_at >= ?');
    params.push(start);
  }
  if (end) {
    conditions.push('p.created_at < ?');
    params.push(end);
  }
  if (category) {
    conditions.push('p.category = ?');
    params.push(category);
  }
  if (status) {
    conditions.push('p.status = ?');
    params.push(status);
  }
  if (city) {
    // Same case-insensitive exact-match convention already used by
    // properties.ts / public-properties.ts's own city filter — reused,
    // not reinvented.
    conditions.push('LOWER(p.city) = LOWER(?)');
    params.push(city);
  }
  if (ownerCustomerId) {
    conditions.push('p.owner_customer_id = ?');
    params.push(ownerCustomerId);
  }
  return { conditions, params };
}

reportsRoutes.get('/reports/properties', ...staff, async (c) => {
  const { conditions, params } = parsePropertyReportFilters(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const whereAnd = conditions.length > 0 ? `${where} AND` : 'WHERE';

  const statements = [
    c.env.DB.prepare(`SELECT COUNT(*) c FROM properties p ${where}`).bind(...params),
    c.env.DB.prepare(
      `SELECT p.category cat, COUNT(*) c FROM properties p ${where} GROUP BY p.category`,
    ).bind(...params),
    c.env.DB.prepare(
      `SELECT p.status s, COUNT(*) c FROM properties p ${where} GROUP BY p.status`,
    ).bind(...params),
    c.env.DB.prepare(`SELECT COUNT(*) c FROM properties p ${whereAnd} p.is_public = 1`).bind(
      ...params,
    ),
    // NULL and 0 both mean "not public" — is_public is a nullable
    // boolean in the schema (never defaulted), so this deliberately
    // treats an unset value the same way the public listing endpoint
    // already does (anything other than is_public = 1 is not public).
    c.env.DB.prepare(
      `SELECT COUNT(*) c FROM properties p ${whereAnd} (p.is_public = 0 OR p.is_public IS NULL)`,
    ).bind(...params),
    // Grouped by the normalized (lowercased) city for counting, but the
    // displayed label is one of the actual stored values (MIN picks a
    // deterministic one) — never rewrites stored data, matches Part G's
    // "do not silently alter stored location values" instruction while
    // still avoiding the casing-fragmentation issue flagged in Phase 21.
    c.env.DB.prepare(
      `SELECT MIN(p.city) city, COUNT(*) c FROM properties p ${whereAnd} p.city IS NOT NULL GROUP BY LOWER(p.city) ORDER BY c DESC`,
    ).bind(...params),
  ];
  const [totalResult, byCategoryResult, byStatusResult, publicResult, privateResult, byCityResult] =
    await c.env.DB.batch(statements);

  const byCategory: Record<string, number> = Object.fromEntries(
    PROPERTY_CATEGORIES.map((cat) => [cat, 0]),
  );
  for (const row of (byCategoryResult.results ?? []) as Array<{ cat: string; c: number }>) {
    if (byCategory[row.cat] !== undefined) byCategory[row.cat] = row.c;
  }
  const byStatus: Record<string, number> = Object.fromEntries(PROPERTY_STATUSES.map((s) => [s, 0]));
  for (const row of (byStatusResult.results ?? []) as Array<{ s: string; c: number }>) {
    if (byStatus[row.s] !== undefined) byStatus[row.s] = row.c;
  }
  const byCity = ((byCityResult.results ?? []) as Array<{ city: string; c: number }>).map(
    (row) => ({
      city: row.city,
      count: row.c,
    }),
  );

  return c.json(
    ok({
      total: countOf(totalResult),
      byCategory,
      byStatus,
      publicCount: countOf(publicResult),
      privateCount: countOf(privateResult),
      byCity,
    }),
  );
});

/**
 * Phase 31 — record-level rows behind the /reports/properties KPI,
 * using the identical filter set (parsePropertyReportFilters) and
 * reusing PROPERTY_SELECT_WITH_OWNER verbatim — the exact same
 * properties-LEFT-JOIN-users query GET /properties (list) and
 * GET /properties/:propertyId already use, so this introduces no new
 * join shape and no N+1 (one query for the whole page, regardless of
 * how many rows it returns).
 */
reportsRoutes.get('/reports/properties/records', ...staff, async (c) => {
  const { conditions, params } = parsePropertyReportFilters(c);
  const { page, pageSize } = parsePagination(c);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) c FROM properties p ${where}`)
    .bind(...params)
    .first<CountRow>();
  const total = totalRow?.c ?? 0;

  const rows = await c.env.DB.prepare(
    `${PROPERTY_SELECT_WITH_OWNER} ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<PropertyRow & { owner_name: string | null; owner_mobile: string | null }>();

  const data = (rows.results ?? []).map((row) => ({
    propertyCode: row.property_code,
    propertyType: row.property_type,
    category: row.category,
    city: row.city,
    price: minorUnitsToRupees(row.price_minor_units),
    status: row.status,
    ownerName: row.owner_name,
    isPublic: Boolean(row.is_public),
    createdAt: row.created_at,
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

// --- customers -----------------------------------------------------------

/**
 * Phase 31 — shared by /reports/customers (KPI) and the new
 * /reports/customers/records below. Qualified with the u. alias
 * throughout (including the plain no-join count) because any caller
 * that joins `inquiries` (which also has a created_at column) would
 * otherwise hit a genuinely ambiguous column, the same class of bug
 * already fixed once in this exact query (Phase 22). Date range means
 * "customer created within the period" (u.created_at) — confirmed as
 * the intended semantic for both the KPI's customersInPeriod and this
 * phase's new records endpoint (Phase 31 approved decision 4), not
 * "customer had inquiry activity in the period".
 */
function parseCustomerReportFilters(c: QueryContext): { conditions: string[]; params: unknown[] } {
  const { fromDate, toDate } = parseDateRangeParams(c);
  const { start, end } = getDateRangeBoundsUtc(fromDate, toDate);

  const conditions = ["u.user_type = 'CUSTOMER'"];
  const params: unknown[] = [];
  if (start) {
    conditions.push('u.created_at >= ?');
    params.push(start);
  }
  if (end) {
    conditions.push('u.created_at < ?');
    params.push(end);
  }
  return { conditions, params };
}

reportsRoutes.get('/reports/customers', ...staff, async (c) => {
  const { conditions, params: periodParams } = parseCustomerReportFilters(c);
  const periodWhere = conditions.join(' AND ');

  const statements = [
    c.env.DB.prepare("SELECT COUNT(*) c FROM users WHERE user_type = 'CUSTOMER'"),
    c.env.DB.prepare(`SELECT COUNT(*) c FROM users u WHERE ${periodWhere}`).bind(...periodParams),
    // Top 10 customers by inquiry count, scoped to the same period as
    // customersInPeriod above when a date range is given — kept a fixed,
    // small LIMIT deliberately (see Phase 22 report's Known Limitations)
    // rather than turning this into a paginated list, since a "report"
    // metric is meant to summarize, not replace the existing paginated
    // GET /customers endpoint.
    c.env.DB.prepare(
      `SELECT u.id id, u.name name, COUNT(i.id) c
         FROM users u LEFT JOIN inquiries i ON i.customer_id = u.id
         WHERE ${periodWhere}
         GROUP BY u.id
         ORDER BY c DESC, u.name ASC
         LIMIT 10`,
    ).bind(...periodParams),
  ];
  const [totalResult, periodResult, topResult] = await c.env.DB.batch(statements);

  const topCustomersByInquiries = (
    (topResult.results ?? []) as Array<{ id: string; name: string; c: number }>
  ).map((row) => ({ customerId: row.id, name: row.name, inquiryCount: row.c }));

  return c.json(
    ok({
      totalCustomers: countOf(totalResult),
      customersInPeriod: countOf(periodResult),
      topCustomersByInquiries,
    }),
  );
});

interface CustomerRecordRow {
  name: string;
  mobile: string | null;
  email: string | null;
  city: string | null;
  status: string;
  created_at: string;
  inquiry_count: number;
}

/**
 * Phase 31 — the full, paginated version of the KPI endpoint's
 * top-10-only topCustomersByInquiries, using the identical filter set
 * (parseCustomerReportFilters) and the same users-LEFT-JOIN-inquiries
 * GROUP BY shape — just without the LIMIT 10, per this phase's explicit
 * "do not retain the existing top-10 limit for this records endpoint"
 * instruction. The total count is computed separately, over the
 * ungrouped customer set (not the joined/grouped rows), so pagination
 * totals reflect "how many customers match", not "how many customer-
 * inquiry pairs exist".
 */
reportsRoutes.get('/reports/customers/records', ...staff, async (c) => {
  const { conditions, params } = parseCustomerReportFilters(c);
  const { page, pageSize } = parsePagination(c);
  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) c FROM users u WHERE ${where}`)
    .bind(...params)
    .first<CountRow>();
  const total = totalRow?.c ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT u.name, u.mobile, u.email, u.city, u.status, u.created_at, COUNT(i.id) AS inquiry_count
     FROM users u LEFT JOIN inquiries i ON i.customer_id = u.id
     WHERE ${where}
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<CustomerRecordRow>();

  const data = (rows.results ?? []).map((row) => ({
    name: row.name,
    mobile: row.mobile,
    email: row.email,
    city: row.city,
    status: row.status,
    inquiryCount: row.inquiry_count,
    createdAt: row.created_at,
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
