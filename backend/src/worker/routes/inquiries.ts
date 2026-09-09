import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import {
  CustomerNotFoundError,
  ForbiddenRoleError,
  InquiryAlreadySubmittedError,
  InquiryAssignmentInvalidError,
  InquiryNotFoundError,
  ok,
  okPaginated,
  PropertyNotFoundError,
  UserNotFoundError,
  ValidationError,
} from '../utils/response';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { recordAudit } from '../utils/audit';
import { minorUnitsToRupees, rupeesToMinorUnits } from '../utils/money';
import { generateInquiryNumber } from '../utils/inquiry-number';
import {
  deriveSyncedLocationFromProperty,
  normalizeLocationValue,
  scoreCityMatch,
  scoreLocalityMatch,
  scorePincodeMatch,
  scoreStateMatch,
} from '../utils/location';
import { parsePagination } from '../utils/pagination';
import { toSquareFeet, type AreaUnit } from '../utils/area-conversion';
import {
  ATTACHMENT_COLUMNS,
  AttachmentRow,
  removeAttachmentInternal,
  toPublicAttachment,
} from './attachments';
import { PROPERTY_AREA_UNITS, PROPERTY_COLUMNS, PropertyRow, toPublicProperty } from './properties';
import { createNotification } from './notifications';
import { sendPushToUser } from '../utils/push';

/**
 * /api/v1/inquiries — ported field-for-field from InquiriesController/
 * InquiriesService. Source of truth verified by direct read this phase:
 * inquiries.controller.ts, inquiries.service.ts, inquiry.mapper.ts,
 * assignment.mapper.ts, inquiry-match.mapper.ts, inquiry-number.util.ts,
 * location-match.util.ts, create/update/assign/public-visibility/
 * list-query DTOs, and the relevant app.exception.ts classes.
 *
 * Phase 6: reproduces InquiriesService's private notifyInquiryAssigned()
 * exactly (see createInquiryAssignedNotification below) — called from
 * create() (when an assignee is set at creation), update() (only on an
 * actual reassignment), and assign() (unconditionally), always after the
 * assignment write has committed and always before the audit record,
 * matching the original's exact ordering and its "notification is a
 * best-effort additive side effect, never wrapped in the assignment's
 * own transaction" semantics.
 */

const INQUIRY_TYPES = ['BUYER', 'SELLER'];
const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const INQUIRY_STATUSES = ['NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const MAX_INQUIRY_NUMBER_ATTEMPTS = 5;

export interface InquiryRow {
  id: string;
  inquiry_number: string;
  customer_id: string | null;
  property_id: string | null;
  type: string | null;
  priority: string;
  status: string;
  external_reference: string | null;
  handled_by_user_id: string | null;
  assigned_to_user_id: string | null;
  remarks: string | null;
  is_public: number;
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  max_budget_minor_units: number | null;
  min_budget_minor_units: number | null;
  desired_property_type: string | null;
  desired_min_area: number | null;
  desired_area_unit: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export const INQUIRY_COLUMNS =
  'id, inquiry_number, customer_id, property_id, type, priority, status, external_reference, handled_by_user_id, assigned_to_user_id, remarks, is_public, city, state, pincode, locality, max_budget_minor_units, min_budget_minor_units, desired_property_type, desired_min_area, desired_area_unit, submitted_at, created_at, updated_at, created_by';

interface UserSummaryRow {
  id: string;
  user_id: string | null;
  user_type: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: string;
}

function toInquiryCustomerSummary(row: UserSummaryRow) {
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

function toUserSummary(
  id: string | null,
  name: string | null,
): { id: string; name: string } | null {
  if (!id) return null;
  return { id, name: name ?? '' };
}

/** Matches inquiry.mapper.ts's toPublicInquiry() exactly. */
export function toPublicInquiry(
  row: InquiryRow,
  extra: {
    customerName: string | null;
    handledByName: string | null;
    assignedToName: string | null;
  },
) {
  return {
    id: row.id,
    inquiryNumber: row.inquiry_number,
    customerId: row.customer_id,
    customerName: extra.customerName,
    propertyId: row.property_id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    externalReference: row.external_reference,
    handledByUserId: row.handled_by_user_id,
    handledBy: toUserSummary(row.handled_by_user_id, extra.handledByName),
    assignedToUserId: row.assigned_to_user_id,
    assignedTo: toUserSummary(row.assigned_to_user_id, extra.assignedToName),
    remarks: row.remarks,
    isPublic: Boolean(row.is_public),
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    locality: row.locality,
    maxBudget: minorUnitsToRupees(row.max_budget_minor_units),
    minBudget: minorUnitsToRupees(row.min_budget_minor_units),
    desiredPropertyType: row.desired_property_type,
    desiredMinArea: row.desired_min_area,
    desiredAreaUnit: row.desired_area_unit,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface Actor {
  userId: string;
  role: 'ADMIN' | 'EMPLOYEE';
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertCustomer(db: D1Database, customerId: string): Promise<void> {
  const user = await db
    .prepare("SELECT id FROM users WHERE id = ? AND user_type = 'CUSTOMER'")
    .bind(customerId)
    .first();
  if (!user) throw new CustomerNotFoundError();
}

interface PropertyLocationSnapshot {
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  // Phase 39 (#15) — added for the ADMIN Group B check below; harmless
  // for every existing caller of assertProperty(), which only ever read
  // the location fields.
  property_type: string | null;
}

async function assertProperty(
  db: D1Database,
  propertyId: string,
): Promise<PropertyLocationSnapshot> {
  const property = await db
    .prepare('SELECT city, state, pincode, locality, property_type FROM properties WHERE id = ?')
    .bind(propertyId)
    .first<PropertyLocationSnapshot>();
  if (!property) throw new PropertyNotFoundError();
  return property;
}

async function assertApplicationUser(db: D1Database, userId: string): Promise<void> {
  const user = await db
    .prepare('SELECT user_type FROM users WHERE id = ?')
    .bind(userId)
    .first<{ user_type: string }>();
  if (!user || user.user_type !== 'APPLICATION_USER') {
    throw new UserNotFoundError('handledByUserId must reference an existing APPLICATION_USER.');
  }
}

async function assertAssignableUser(db: D1Database, userId: string | null): Promise<void> {
  if (!userId) {
    throw new InquiryAssignmentInvalidError(
      'assignedToUserId does not reference an existing user.',
    );
  }
  const user = await db
    .prepare('SELECT user_type, status FROM users WHERE id = ?')
    .bind(userId)
    .first<{
      user_type: string;
      status: string;
    }>();
  if (!user) {
    throw new InquiryAssignmentInvalidError(
      'assignedToUserId does not reference an existing user.',
    );
  }
  if (user.user_type !== 'APPLICATION_USER') {
    throw new InquiryAssignmentInvalidError(
      `assignedToUserId must reference an APPLICATION_USER; found userType ${user.user_type}.`,
    );
  }
  if (user.status !== 'ACTIVE') {
    throw new InquiryAssignmentInvalidError(
      `assignedToUserId must reference an ACTIVE user; found status ${user.status}.`,
    );
  }
}

async function resolveInquiryNumber(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < MAX_INQUIRY_NUMBER_ATTEMPTS; attempt++) {
    const candidate = generateInquiryNumber();
    const existing = await db
      .prepare('SELECT id FROM inquiries WHERE inquiry_number = ?')
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique inquiry number after several attempts.');
}

/**
 * The single shared ownership rule (Phase 23A in the real backend):
 * ADMIN can modify any inquiry; EMPLOYEE only the inquiry currently
 * assigned to them. This is the fast-fail pre-check (matches
 * InquiriesService.assertCanModifyInquiry() exactly) — the actual
 * enforcement boundary is the conditional WHERE clause built by
 * conditionalPredicate() below, used in the write itself.
 */
function assertCanModifyInquiry(
  existing: { assigned_to_user_id: string | null },
  actor: Actor,
): void {
  if (actor.role === 'EMPLOYEE' && existing.assigned_to_user_id !== actor.userId) {
    throw new ForbiddenRoleError('You can only modify inquiries currently assigned to you.');
  }
}

/**
 * TOCTOU-safe write predicate — this phase's D1 equivalent of
 * InquiriesService.applyInquiryWrite()'s conditional
 * client.inquiry.updateMany({ where: { id, assignedToUserId: actor.userId } }).
 * ADMIN: unconditional (`id = ?`). EMPLOYEE: `id = ? AND assigned_to_user_id = ?`
 * — the ownership guarantee lives in this predicate, baked into the same
 * atomic UPDATE (and, where relevant, the same atomic INSERT...SELECT for
 * assignment history — see assign()/update() below), not solely in the
 * assertCanModifyInquiry() read above. A second request that reassigns
 * the inquiry in the gap between that read and this write causes the
 * conditional write to match zero rows, resolved by
 * resolveConditionalWriteFailure() into the correct 404-vs-403 outcome
 * rather than silently succeeding on stale authorization.
 */
function conditionalPredicate(actor: Actor, id: string): { clause: string; params: unknown[] } {
  if (actor.role !== 'EMPLOYEE') {
    return { clause: 'id = ?', params: [id] };
  }
  return { clause: 'id = ? AND assigned_to_user_id = ?', params: [id, actor.userId] };
}

async function resolveConditionalWriteFailure(db: D1Database, id: string): Promise<never> {
  const stillExists = await db.prepare('SELECT id FROM inquiries WHERE id = ?').bind(id).first();
  if (!stillExists) throw new InquiryNotFoundError();
  throw new ForbiddenRoleError('You can only modify inquiries currently assigned to you.');
}

/**
 * D1 equivalent of InquiriesService's private notifyInquiryAssigned()
 * (Phase 6) — reproduced exactly:
 *  - ADMIN-only: an EMPLOYEE assigning/reassigning (self-service handoff)
 *    never creates a notification, but is never blocked either — purely
 *    an additive side effect gated on actor.role.
 *  - Only the NEW assignee is notified — the previous assignee (if any)
 *    receives nothing, in any of the three call sites.
 *  - Exact type/title/message/entityType/entityId, unchanged.
 *  - Awaited, not fire-and-forget, but deliberately NOT part of the same
 *    D1 batch/transaction as the assignment write — every call site
 *    below invokes this only AFTER that write has already been
 *    confirmed to have succeeded (batch committed, and — for the
 *    TOCTOU-safe paths — the meta.changes check has already passed), so
 *    a failure here can never roll back or partially undo an assignment
 *    that has already durably committed. It can, however, still cause
 *    the overall HTTP response to surface as an error even though the
 *    assignment succeeded underneath — identical to the original's own
 *    documented risk ("the assignment itself must never fail or roll
 *    back because notification creation had a problem"), not a Worker-
 *    specific regression.
 *
 * Phase 41C: after the notifications row commits, this is also the one
 * and only place a push notification is triggered for an assignment —
 * every one of this function's three call sites (create with assignee,
 * update/reassign, dedicated assign endpoint) automatically gets push
 * support with no per-call-site duplication. Push delivery is fully
 * isolated in utils/push.ts's sendPushToUser (Phase 41F: extracted out
 * of this file so scheduled/follow-up-reminders.ts can share the exact
 * same token-lookup/send logic instead of duplicating it): any failure
 * there (missing FCM config, network error, Google/FCM rejecting the
 * request) is caught and logged inside that function and can never
 * propagate out of this one, so it can never fail or roll back the
 * notification row (already committed above) or the assignment
 * operation that triggered all of this.
 */
async function createInquiryAssignedNotification(
  env: Bindings,
  actor: Actor,
  inquiryId: string,
  inquiryNumber: string,
  assignedToUserId: string,
): Promise<void> {
  if (actor.role !== 'ADMIN') return;

  const title = 'New inquiry assigned';
  const message = `You have been assigned inquiry ${inquiryNumber}.`;

  const notificationId = await createNotification(env.DB, {
    userId: assignedToUserId,
    type: 'INQUIRY_ASSIGNED',
    title,
    message,
    entityType: 'INQUIRY',
    entityId: inquiryId,
  });

  await sendPushToUser(env, {
    userId: assignedToUserId,
    notificationId,
    entityType: 'INQUIRY',
    entityId: inquiryId,
    title,
    message,
    logContext: 'Inquiry-assigned push',
  });
}

async function toDetail(db: D1Database, row: InquiryRow) {
  const [customer, property, attachments, handledBy, assignedTo] = await Promise.all([
    row.customer_id
      ? db
          .prepare(
            'SELECT id, user_id, user_type, role, name, email, mobile, status FROM users WHERE id = ?',
          )
          .bind(row.customer_id)
          .first<UserSummaryRow>()
      : Promise.resolve(null),
    row.property_id
      ? db
          .prepare(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ?`)
          .bind(row.property_id)
          .first<PropertyRow>()
      : Promise.resolve(null),
    db
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE inquiry_id = ? ORDER BY display_order ASC, created_at DESC`,
      )
      .bind(row.id)
      .all<AttachmentRow>(),
    row.handled_by_user_id
      ? db
          .prepare('SELECT name FROM users WHERE id = ?')
          .bind(row.handled_by_user_id)
          .first<{ name: string }>()
      : Promise.resolve(null),
    row.assigned_to_user_id
      ? db
          .prepare('SELECT name FROM users WHERE id = ?')
          .bind(row.assigned_to_user_id)
          .first<{ name: string }>()
      : Promise.resolve(null),
  ]);

  return {
    ...toPublicInquiry(row, {
      customerName: customer?.name ?? null,
      handledByName: handledBy?.name ?? null,
      assignedToName: assignedTo?.name ?? null,
    }),
    customer: customer ? toInquiryCustomerSummary(customer) : undefined,
    property: property ? toPublicProperty(property) : null,
    attachments: ((attachments.results ?? []) as AttachmentRow[]).map(toPublicAttachment),
  };
}

// --- validation -----------------------------------------------------

const EXTERNAL_REF_MAX = 255;

interface InquiryInput {
  customerId?: string;
  propertyId?: string;
  type?: string;
  priority?: string;
  status?: string;
  externalReference?: string;
  city?: string;
  state?: string;
  pincode?: string;
  locality?: string;
  maxBudget?: number;
  minBudget?: number;
  desiredPropertyType?: string;
  desiredMinArea?: number;
  desiredAreaUnit?: string;
  handledByUserId?: string;
  remarks?: string;
  // assignedToUserId is tracked separately (see parseInquiryBody) because
  // its "explicitly null" vs "absent" distinction is meaningful for
  // update()'s isReassigning check — every other field collapses null to
  // "not provided", matching every other field's `dto.field ?? undefined`
  // handling in the real service.
}

function parseInquiryBody(
  body: unknown,
  opts: { allowStatus: boolean; trackAssignedTo: boolean },
): {
  input: InquiryInput;
  assignedToUserIdProvided: boolean;
  assignedToUserIdValue: string | null;
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;
  const result: InquiryInput = {};

  if (b.customerId !== undefined && b.customerId !== null) {
    if (typeof b.customerId !== 'string' || !isValidUuid(b.customerId)) {
      throw new ValidationError('customerId must be a UUID.');
    }
    result.customerId = b.customerId;
  }
  if (b.propertyId !== undefined && b.propertyId !== null) {
    if (typeof b.propertyId !== 'string' || !isValidUuid(b.propertyId)) {
      throw new ValidationError('propertyId must be a UUID.');
    }
    result.propertyId = b.propertyId;
  }
  if (b.type !== undefined && b.type !== null) {
    if (typeof b.type !== 'string' || !INQUIRY_TYPES.includes(b.type)) {
      throw new ValidationError(`type must be one of ${INQUIRY_TYPES.join(', ')}.`);
    }
    result.type = b.type;
  }
  if (b.priority !== undefined && b.priority !== null) {
    if (typeof b.priority !== 'string' || !INQUIRY_PRIORITIES.includes(b.priority)) {
      throw new ValidationError(`priority must be one of ${INQUIRY_PRIORITIES.join(', ')}.`);
    }
    result.priority = b.priority;
  }
  if (opts.allowStatus) {
    if (b.status !== undefined && b.status !== null) {
      if (typeof b.status !== 'string' || !INQUIRY_STATUSES.includes(b.status)) {
        throw new ValidationError(`status must be one of ${INQUIRY_STATUSES.join(', ')}.`);
      }
      result.status = b.status;
    }
  } else if (b.status !== undefined) {
    throw new ValidationError('status is not accepted on create.');
  }
  if (b.externalReference !== undefined && b.externalReference !== null) {
    if (typeof b.externalReference !== 'string' || b.externalReference.length > EXTERNAL_REF_MAX) {
      throw new ValidationError(
        `externalReference must be a string, max ${EXTERNAL_REF_MAX} characters.`,
      );
    }
    result.externalReference = b.externalReference;
  }
  if (b.city !== undefined && b.city !== null) {
    if (typeof b.city !== 'string' || b.city.length > 100)
      throw new ValidationError('city must be a string, max 100 characters.');
    result.city = b.city;
  }
  if (b.state !== undefined && b.state !== null) {
    if (typeof b.state !== 'string' || b.state.length > 100)
      throw new ValidationError('state must be a string, max 100 characters.');
    result.state = b.state;
  }
  if (b.pincode !== undefined && b.pincode !== null) {
    if (typeof b.pincode !== 'string' || b.pincode.length > 10)
      throw new ValidationError('pincode must be a string, max 10 characters.');
    result.pincode = b.pincode;
  }
  if (b.locality !== undefined && b.locality !== null) {
    if (typeof b.locality !== 'string' || b.locality.length > 150)
      throw new ValidationError('locality must be a string, max 150 characters.');
    result.locality = b.locality;
  }
  if (b.maxBudget !== undefined && b.maxBudget !== null) {
    if (typeof b.maxBudget !== 'number' || !Number.isFinite(b.maxBudget) || b.maxBudget < 0) {
      throw new ValidationError('maxBudget must be a number >= 0.');
    }
    result.maxBudget = b.maxBudget;
  }
  // Phase 40B — buyer preference fields for the redesigned matching
  // engine (see GET /inquiries/:inquiryId/matches below). All four are
  // optional on both create and update; a NULL/omitted value means "no
  // preference stated" and is excluded from matching, never treated as
  // a failed match.
  if (b.minBudget !== undefined && b.minBudget !== null) {
    if (typeof b.minBudget !== 'number' || !Number.isFinite(b.minBudget) || b.minBudget < 0) {
      throw new ValidationError('minBudget must be a number >= 0.');
    }
    result.minBudget = b.minBudget;
  }
  if (b.desiredPropertyType !== undefined && b.desiredPropertyType !== null) {
    if (typeof b.desiredPropertyType !== 'string') {
      throw new ValidationError('desiredPropertyType must be a string.');
    }
    const trimmed = b.desiredPropertyType.trim();
    // Bounded consistently with properties.ts's own propertyType rule
    // (1-50 characters after trimming) — the same free-text field this
    // is compared against during matching, so the same length rule
    // applies here rather than inventing a separate one.
    if (trimmed.length < 1 || trimmed.length > 50) {
      throw new ValidationError('desiredPropertyType must be 1-50 characters.');
    }
    result.desiredPropertyType = trimmed;
  }
  if (b.desiredMinArea !== undefined && b.desiredMinArea !== null) {
    if (
      typeof b.desiredMinArea !== 'number' ||
      !Number.isFinite(b.desiredMinArea) ||
      b.desiredMinArea < 0
    ) {
      throw new ValidationError('desiredMinArea must be a number >= 0.');
    }
    result.desiredMinArea = b.desiredMinArea;
  }
  if (b.desiredAreaUnit !== undefined && b.desiredAreaUnit !== null) {
    if (typeof b.desiredAreaUnit !== 'string' || !PROPERTY_AREA_UNITS.includes(b.desiredAreaUnit)) {
      throw new ValidationError(
        `desiredAreaUnit must be one of ${PROPERTY_AREA_UNITS.join(', ')}.`,
      );
    }
    result.desiredAreaUnit = b.desiredAreaUnit;
  }
  if (b.handledByUserId !== undefined && b.handledByUserId !== null) {
    if (typeof b.handledByUserId !== 'string' || !isValidUuid(b.handledByUserId)) {
      throw new ValidationError('handledByUserId must be a UUID.');
    }
    result.handledByUserId = b.handledByUserId;
  }
  if (b.remarks !== undefined && b.remarks !== null) {
    if (typeof b.remarks !== 'string') throw new ValidationError('remarks must be a string.');
    result.remarks = b.remarks;
  }

  let assignedToUserIdProvided = false;
  let assignedToUserIdValue: string | null = null;
  if (opts.trackAssignedTo) {
    // Matches UpdateInquiryDto's `dto.assignedToUserId !== undefined` check
    // exactly: an explicit `null` IS "provided" here (unlike every other
    // field above), triggering isReassigning with a value that then fails
    // assertAssignableUser() — reproducing the real service's behavior for
    // this edge case rather than silently treating null as absent.
    if (b.assignedToUserId !== undefined) {
      assignedToUserIdProvided = true;
      if (b.assignedToUserId === null) {
        assignedToUserIdValue = null;
      } else if (typeof b.assignedToUserId === 'string' && isValidUuid(b.assignedToUserId)) {
        assignedToUserIdValue = b.assignedToUserId;
      } else {
        throw new ValidationError('assignedToUserId must be a UUID.');
      }
    }
  } else if (b.assignedToUserId !== undefined && b.assignedToUserId !== null) {
    // create(): no isReassigning distinction exists, so null and absent
    // are equivalent here (both "no explicit assignee") — matches every
    // other field's handling above.
    if (typeof b.assignedToUserId !== 'string' || !isValidUuid(b.assignedToUserId)) {
      throw new ValidationError('assignedToUserId must be a UUID.');
    }
    assignedToUserIdProvided = true;
    assignedToUserIdValue = b.assignedToUserId;
  }

  return { input: result, assignedToUserIdProvided, assignedToUserIdValue };
}

export const inquiriesRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;
const adminOnly = [requireApplicationAuth, requireRoles('ADMIN')] as const;

// --- list / get -------------------------------------------------------

inquiriesRoutes.get('/inquiries', ...staff, async (c) => {
  const { page, pageSize } = parsePagination(c);
  const status = c.req.query('status');
  const priority = c.req.query('priority');
  const assignedToUserId = c.req.query('assignedToUserId');
  const handledByUserId = c.req.query('handledByUserId');
  const customerId = c.req.query('customerId');
  const propertyId = c.req.query('propertyId');

  if (status && !INQUIRY_STATUSES.includes(status))
    throw new ValidationError(`status must be one of ${INQUIRY_STATUSES.join(', ')}.`);
  if (priority && !INQUIRY_PRIORITIES.includes(priority))
    throw new ValidationError(`priority must be one of ${INQUIRY_PRIORITIES.join(', ')}.`);
  for (const [name, value] of [
    ['assignedToUserId', assignedToUserId],
    ['handledByUserId', handledByUserId],
    ['customerId', customerId],
    ['propertyId', propertyId],
  ] as const) {
    if (value && !isValidUuid(value)) throw new ValidationError(`${name} must be a UUID.`);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  }
  if (priority) {
    conditions.push('i.priority = ?');
    params.push(priority);
  }
  if (assignedToUserId) {
    conditions.push('i.assigned_to_user_id = ?');
    params.push(assignedToUserId);
  }
  if (handledByUserId) {
    conditions.push('i.handled_by_user_id = ?');
    params.push(handledByUserId);
  }
  if (customerId) {
    conditions.push('i.customer_id = ?');
    params.push(customerId);
  }
  if (propertyId) {
    conditions.push('i.property_id = ?');
    params.push(propertyId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM inquiries i ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const cols = INQUIRY_COLUMNS.split(', ')
    .map((col) => `i.${col}`)
    .join(', ');
  // Phase 39 (#5) — LEFT JOIN so a BUYER inquiry with no linked property
  // still returns a row (property_type simply comes back null for it).
  // `propertyType` is added only to this list response, not to
  // toPublicInquiry() itself: the detail response already carries the
  // full embedded `property` object (including its own `propertyType`),
  // so duplicating it into the shared mapper would be redundant and risk
  // changing the established detail shape for no reason.
  const rows = await c.env.DB.prepare(
    `SELECT ${cols}, cu.name AS customer_name, hb.name AS handled_by_name, ao.name AS assigned_to_name, p.property_type AS property_type
     FROM inquiries i
     LEFT JOIN users cu ON cu.id = i.customer_id
     LEFT JOIN users hb ON hb.id = i.handled_by_user_id
     LEFT JOIN users ao ON ao.id = i.assigned_to_user_id
     LEFT JOIN properties p ON p.id = i.property_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<
      InquiryRow & {
        customer_name: string | null;
        handled_by_name: string | null;
        assigned_to_name: string | null;
        property_type: string | null;
      }
    >();

  const data = (rows.results ?? []).map((row) => ({
    ...toPublicInquiry(row, {
      customerName: row.customer_name,
      handledByName: row.handled_by_name,
      assignedToName: row.assigned_to_name,
    }),
    propertyType: row.property_type,
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

inquiriesRoutes.get('/inquiries/:inquiryId', ...staff, async (c) => {
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const row = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!row) throw new InquiryNotFoundError();

  return c.json(ok(await toDetail(c.env.DB, row)));
});

// --- create -------------------------------------------------------

inquiriesRoutes.post('/inquiries', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const { input, assignedToUserIdValue: assignedToUserIdRaw } = parseInquiryBody(
    await c.req.json().catch(() => null),
    {
      allowStatus: false,
      trackAssignedTo: false,
    },
  );

  if (input.customerId) await assertCustomer(c.env.DB, input.customerId);

  let property: PropertyLocationSnapshot | null = null;
  if (input.propertyId) property = await assertProperty(c.env.DB, input.propertyId);

  if (input.handledByUserId) await assertApplicationUser(c.env.DB, input.handledByUserId);

  if (assignedToUserIdRaw) await assertAssignableUser(c.env.DB, assignedToUserIdRaw);

  // Phase 39 (#14/#15) — replaces the old unconditional "ADMIN-created
  // inquiry needs a recording, enforced at submit time" rule (the
  // Submit Inquiry concept is being removed) with an OR-of-two-groups
  // rule, checked here at creation time using only what this request can
  // actually verify synchronously:
  //   Group A (recording + assigned employee) — `assignedToUserId` is
  //     checkable here (already supported by parseInquiryBody for
  //     create, above); a RECORDING attachment fundamentally cannot be
  //     verified before this inquiry row exists (the attachments table's
  //     own CHECK constraint requires a non-null inquiry_id for a
  //     RECORDING row), so this check covers the employee half only —
  //     the Flutter ADMIN screen is responsible for never calling this
  //     endpoint as part of a "Group A" submission without also
  //     uploading a recording immediately afterward. This is a known,
  //     deliberate limitation (see the Phase 39 report), not an
  //     oversight.
  //   Group B (customer property + property type) — both fields come
  //     from this same request (`propertyId`, looked up above) and are
  //     fully verifiable here.
  // EMPLOYEE-created inquiries are entirely unaffected — this rule only
  // ever applies to actor.role === 'ADMIN'.
  // Hoisted out of the `role === 'ADMIN'` gate below (recording-
  // enforcement fix) — groupBComplete is a pure fact about the request,
  // independent of role, and is now also needed further down to decide
  // submittedAtValue at INSERT time, not just for this validation gate.
  const groupBComplete = Boolean(
    input.propertyId &&
    property &&
    property.property_type &&
    property.property_type.trim().length > 0,
  );

  if (actor.role === 'ADMIN') {
    const groupAComplete = Boolean(assignedToUserIdRaw);
    if (!groupAComplete && !groupBComplete) {
      throw new ValidationError(
        'Provide an assigned employee (with a call recording uploaded immediately after creation), ' +
          'or select a customer property that has a property type set.',
      );
    }
  }

  const location =
    input.type === 'SELLER' && property
      ? deriveSyncedLocationFromProperty(property)
      : {
          city: normalizeLocationValue(input.city),
          state: normalizeLocationValue(input.state),
          pincode: normalizeLocationValue(input.pincode),
          locality: normalizeLocationValue(input.locality),
        };

  const handledByUserId =
    input.handledByUserId ?? (actor.role === 'EMPLOYEE' ? actor.userId : null);
  const assignedToUserId = assignedToUserIdRaw ?? (actor.role === 'EMPLOYEE' ? actor.userId : null);

  const inquiryNumber = await resolveInquiryNumber(c.env.DB);
  const id = newId();
  const now = nowIso();
  const maxBudgetMinorUnits = rupeesToMinorUnits(input.maxBudget ?? null);
  const minBudgetMinorUnits = rupeesToMinorUnits(input.minBudget ?? null);

  // Recording-enforcement fix — an ADMIN-created inquiry whose Group B is
  // already fully verifiable right here (property + non-blank
  // propertyType) is finalized immediately: no /submit call will ever
  // follow it under the approved Flutter flow, so submitted_at must be
  // set now rather than staying NULL forever — otherwise the scheduled
  // inquiry-verification sweep (src/worker/scheduled/
  // inquiry-verification-reaper.ts) would eventually mistake a fully
  // valid Group-B-only inquiry for an abandoned one. An ADMIN Group-A-
  // only inquiry (employee only, recording still to come) deliberately
  // keeps submitted_at NULL here — POST /inquiries/:inquiryId/submit is
  // what verifies the real recording and finalizes it. EMPLOYEE-created
  // inquiries are entirely unaffected — submitted_at stays NULL exactly
  // as before this fix, since this whole rule only ever applies to
  // actor.role === 'ADMIN'.
  const submittedAtValue = actor.role === 'ADMIN' && groupBComplete ? now : null;

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO inquiries (
        id, inquiry_number, customer_id, property_id, type, priority, status, external_reference,
        handled_by_user_id, assigned_to_user_id, remarks, is_public, city, state, pincode, locality,
        max_budget_minor_units, min_budget_minor_units, desired_property_type, desired_min_area, desired_area_unit,
        submitted_at, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      inquiryNumber,
      input.customerId ?? null,
      input.propertyId ?? null,
      input.type ?? null,
      input.priority ?? 'MEDIUM',
      input.externalReference ?? null,
      handledByUserId,
      assignedToUserId,
      input.remarks ?? null,
      location.city,
      location.state,
      location.pincode,
      location.locality,
      maxBudgetMinorUnits,
      minBudgetMinorUnits,
      input.desiredPropertyType ?? null,
      input.desiredMinArea ?? null,
      input.desiredAreaUnit ?? null,
      submittedAtValue,
      now,
      now,
      actor.userId,
      actor.userId,
    ),
  ];
  if (assignedToUserId) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO inquiry_assignments (id, inquiry_id, assigned_from_user_id, assigned_to_user_id, reason, created_by, assigned_at)
         VALUES (?, ?, NULL, ?, NULL, ?, ?)`,
      ).bind(newId(), id, assignedToUserId, actor.userId, now),
    );
  }

  await c.env.DB.batch(statements);

  // Matches InquiriesService.create() exactly: notifyInquiryAssigned() is
  // called after the create transaction commits, before the audit
  // record, and only when an assignee was set on creation. See
  // createInquiryAssignedNotification's doc comment for the full ADMIN-
  // only / non-transactional semantics this reproduces.
  if (assignedToUserId) {
    await createInquiryAssignedNotification(c.env, actor, id, inquiryNumber, assignedToUserId);
  }

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'INQUIRY_CREATED',
    newValues: {
      ...input,
      assignedToUserId: assignedToUserIdRaw,
      inquiryNumber,
      handledByUserId,
      ...location,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  return c.json(ok(await toDetail(c.env.DB, row!)), 201);
});

// --- update (TOCTOU-safe) -------------------------------------------

inquiriesRoutes.patch('/inquiries/:inquiryId', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!existing) throw new InquiryNotFoundError();

  assertCanModifyInquiry(existing, actor);

  const rawBody = await c.req.json().catch(() => null);
  const { input, assignedToUserIdProvided, assignedToUserIdValue } = parseInquiryBody(rawBody, {
    allowStatus: true,
    trackAssignedTo: true,
  });

  if (input.customerId && input.customerId !== existing.customer_id) {
    await assertCustomer(c.env.DB, input.customerId);
  }

  const resultingType = input.type ?? existing.type;
  const resultingPropertyId = input.propertyId ?? existing.property_id;

  const isLinkingNewProperty =
    input.propertyId !== undefined && input.propertyId !== existing.property_id;
  const isTransitioningIntoSeller = existing.type !== 'SELLER' && resultingType === 'SELLER';

  let newProperty: PropertyLocationSnapshot | null = null;
  if (isLinkingNewProperty) {
    newProperty = await assertProperty(c.env.DB, input.propertyId as string);
  } else if (isTransitioningIntoSeller && resultingPropertyId) {
    newProperty = await assertProperty(c.env.DB, resultingPropertyId);
  }

  if (input.handledByUserId && input.handledByUserId !== existing.handled_by_user_id) {
    await assertApplicationUser(c.env.DB, input.handledByUserId);
  }

  const isReassigning =
    assignedToUserIdProvided && assignedToUserIdValue !== existing.assigned_to_user_id;
  if (isReassigning) {
    await assertAssignableUser(c.env.DB, assignedToUserIdValue);
  }

  const sellerWithProperty = resultingType === 'SELLER' && !!resultingPropertyId;
  let locationUpdate: Partial<PropertyLocationSnapshot> = {};
  if (sellerWithProperty) {
    if ((isLinkingNewProperty || isTransitioningIntoSeller) && newProperty) {
      locationUpdate = deriveSyncedLocationFromProperty(newProperty);
    }
  } else {
    if (input.city !== undefined) locationUpdate.city = normalizeLocationValue(input.city);
    if (input.state !== undefined) locationUpdate.state = normalizeLocationValue(input.state);
    if (input.pincode !== undefined) locationUpdate.pincode = normalizeLocationValue(input.pincode);
    if (input.locality !== undefined)
      locationUpdate.locality = normalizeLocationValue(input.locality);
  }

  const oldValues = {
    customerId: existing.customer_id,
    propertyId: existing.property_id,
    type: existing.type,
    priority: existing.priority,
    status: existing.status,
    externalReference: existing.external_reference,
    handledByUserId: existing.handled_by_user_id,
    assignedToUserId: existing.assigned_to_user_id,
    remarks: existing.remarks,
    city: existing.city,
    state: existing.state,
    pincode: existing.pincode,
    locality: existing.locality,
    maxBudget: minorUnitsToRupees(existing.max_budget_minor_units),
    minBudget: minorUnitsToRupees(existing.min_budget_minor_units),
    desiredPropertyType: existing.desired_property_type,
    desiredMinArea: existing.desired_min_area,
    desiredAreaUnit: existing.desired_area_unit,
  };

  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (input.customerId !== undefined) set('customer_id', input.customerId);
  if (input.propertyId !== undefined) set('property_id', input.propertyId);
  if (input.type !== undefined) set('type', input.type);
  if (input.priority !== undefined) set('priority', input.priority);
  if (input.status !== undefined) set('status', input.status);
  if (input.externalReference !== undefined) set('external_reference', input.externalReference);
  if (isReassigning) {
    set('handled_by_user_id', assignedToUserIdValue);
    set('assigned_to_user_id', assignedToUserIdValue);
  } else if (input.handledByUserId !== undefined) {
    set('handled_by_user_id', input.handledByUserId);
  }
  if (input.remarks !== undefined) set('remarks', input.remarks);
  if ('city' in locationUpdate) set('city', locationUpdate.city);
  if ('state' in locationUpdate) set('state', locationUpdate.state);
  if ('pincode' in locationUpdate) set('pincode', locationUpdate.pincode);
  if ('locality' in locationUpdate) set('locality', locationUpdate.locality);
  if (input.maxBudget !== undefined)
    set('max_budget_minor_units', rupeesToMinorUnits(input.maxBudget));
  if (input.minBudget !== undefined)
    set('min_budget_minor_units', rupeesToMinorUnits(input.minBudget));
  if (input.desiredPropertyType !== undefined)
    set('desired_property_type', input.desiredPropertyType);
  if (input.desiredMinArea !== undefined) set('desired_min_area', input.desiredMinArea);
  if (input.desiredAreaUnit !== undefined) set('desired_area_unit', input.desiredAreaUnit);
  set('updated_at', nowIso());
  set('updated_by', actor.userId);

  const predicate = conditionalPredicate(actor, id);
  const statements = [];
  if (isReassigning) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO inquiry_assignments (id, inquiry_id, assigned_from_user_id, assigned_to_user_id, reason, created_by, assigned_at)
         SELECT ?, id, assigned_to_user_id, ?, NULL, ?, ?
         FROM inquiries WHERE ${predicate.clause}`,
      ).bind(newId(), assignedToUserIdValue, actor.userId, nowIso(), ...predicate.params),
    );
  }
  statements.push(
    c.env.DB.prepare(`UPDATE inquiries SET ${fields.join(', ')} WHERE ${predicate.clause}`).bind(
      ...params,
      ...predicate.params,
    ),
  );

  const results = await c.env.DB.batch(statements);
  const updateResult = results[results.length - 1];
  if (!updateResult.meta.changes) {
    await resolveConditionalWriteFailure(c.env.DB, id);
  }

  const updated = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();

  // Matches InquiriesService.update() exactly: notifyInquiryAssigned()
  // only when this request is an actual reassignment, called after the
  // write is confirmed to have succeeded (the resolveConditionalWriteFailure
  // check above already guarantees that), using the pre-update
  // inquiryNumber (unchanged by this write) and the new assignee.
  if (isReassigning) {
    await createInquiryAssignedNotification(
      c.env,
      actor,
      id,
      existing.inquiry_number,
      assignedToUserIdValue as string,
    );
  }

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'INQUIRY_UPDATED',
    oldValues,
    newValues: { ...input, assignedToUserId: assignedToUserIdValue, ...locationUpdate },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return c.json(ok(await toDetail(c.env.DB, updated!)));
});

// --- delete -------------------------------------------------------

inquiriesRoutes.delete('/inquiries/:inquiryId', ...adminOnly, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!existing) throw new InquiryNotFoundError();

  const actor = {
    userId: applicationUser.sub,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };

  // attachments.inquiry_id is ON DELETE CASCADE, same as
  // attachments.property_id — a raw cascade would silently orphan the
  // R2 objects, so each is removed first through the exact same
  // R2-then-DB-then-audit path as a direct DELETE /attachments/:id call
  // (see routes/properties.ts's delete() for the identical pattern).
  // follow_ups.inquiry_id and inquiry_assignments.inquiry_id are also ON
  // DELETE CASCADE (verified in migrations/0001_initial_schema.sql) —
  // both are pure DB rows with no R2 dependency, so the plain cascade
  // triggered by the final DELETE below reproduces the original's
  // "cascade already leaves no orphans in those two tables" behavior
  // exactly, with no separate cleanup needed.
  const attachmentIds = await c.env.DB.prepare('SELECT id FROM attachments WHERE inquiry_id = ?')
    .bind(id)
    .all<{ id: string }>();
  for (const attachment of attachmentIds.results ?? []) {
    await removeAttachmentInternal(c.env, c.env.DB, attachment.id, actor);
  }

  await c.env.DB.prepare('DELETE FROM inquiries WHERE id = ?').bind(id).run();

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'INQUIRY_DELETED',
    oldValues: {
      inquiryNumber: existing.inquiry_number,
      customerId: existing.customer_id,
      propertyId: existing.property_id,
      status: existing.status,
      assignedToUserId: existing.assigned_to_user_id,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return c.body(null, 204);
});

// --- submit (double-submit-safe; internal finalization step) --------------
//
// Phase 39 (#14) — the user-facing "Submit Inquiry" concept remains
// removed (no Flutter screen presents this as a user-facing action; it
// is called internally, immediately after a Group A recording upload
// succeeds — see AdminQuickCaptureScreen). This route was deliberately
// kept rather than deleted when Phase 39 first moved the Group A/B rule
// to creation time.
//
// Recording-enforcement fix — restores a Group A/B check here, but not
// the old *unconditional* one: this is the one place that can actually
// verify Group A's recording half (POST /inquiries never could, since
// the row didn't exist yet). Gated on actor.role === 'ADMIN', mirroring
// POST /inquiries' own exact gating, so a non-ADMIN caller (this
// endpoint has no live EMPLOYEE caller today, but the guard stays
// consistent with create's own rule scope rather than assuming that
// away) keeps the endpoint's prior, unconditional finalize behavior.
inquiriesRoutes.post('/inquiries/:inquiryId/submit', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!existing) throw new InquiryNotFoundError();
  if (existing.submitted_at) throw new InquiryAlreadySubmittedError();

  if (actor.role === 'ADMIN') {
    const [recordingRow, propertyRow] = await Promise.all([
      c.env.DB.prepare(
        "SELECT id FROM attachments WHERE inquiry_id = ? AND attachment_type = 'RECORDING' LIMIT 1",
      )
        .bind(id)
        .first(),
      existing.property_id
        ? c.env.DB.prepare('SELECT property_type FROM properties WHERE id = ?')
            .bind(existing.property_id)
            .first<{ property_type: string | null }>()
        : Promise.resolve(null),
    ]);

    const groupAComplete = Boolean(existing.assigned_to_user_id) && Boolean(recordingRow);
    const groupBComplete = Boolean(
      existing.property_id &&
      propertyRow &&
      propertyRow.property_type &&
      propertyRow.property_type.trim().length > 0,
    );

    if (!groupAComplete && !groupBComplete) {
      throw new ValidationError(
        'This inquiry cannot be finalized yet: provide an assigned employee with a call recording, ' +
          'or a customer property that has a property type set.',
      );
    }
  }

  const submittedAt = nowIso();
  const result = await c.env.DB.prepare(
    'UPDATE inquiries SET submitted_at = ?, verification_failed_at = NULL, updated_by = ? WHERE id = ? AND submitted_at IS NULL',
  )
    .bind(submittedAt, actor.userId, id)
    .run();

  if (!result.meta.changes) {
    const current = await c.env.DB.prepare('SELECT id FROM inquiries WHERE id = ?')
      .bind(id)
      .first();
    if (!current) throw new InquiryNotFoundError();
    throw new InquiryAlreadySubmittedError();
  }

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'INQUIRY_SUBMITTED',
    oldValues: { submittedAt: null },
    newValues: { submittedAt },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  return c.json(ok(await toDetail(c.env.DB, row!)));
});

// --- assign (TOCTOU-safe) -------------------------------------------------------

inquiriesRoutes.post('/inquiries/:inquiryId/assign', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!existing) throw new InquiryNotFoundError();

  assertCanModifyInquiry(existing, actor);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ValidationError('Request body must be an object.');
  if (typeof body.assignedToUserId !== 'string' || !isValidUuid(body.assignedToUserId)) {
    throw new ValidationError('assignedToUserId is required and must be a UUID.');
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    throw new ValidationError('reason must be a string.');
  }
  const assignedToUserId = body.assignedToUserId;
  const reason = (body.reason as string | undefined) ?? null;

  await assertAssignableUser(c.env.DB, assignedToUserId);

  const predicate = conditionalPredicate(actor, id);
  const now = nowIso();
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO inquiry_assignments (id, inquiry_id, assigned_from_user_id, assigned_to_user_id, reason, created_by, assigned_at)
       SELECT ?, id, assigned_to_user_id, ?, ?, ?, ?
       FROM inquiries WHERE ${predicate.clause}`,
    ).bind(newId(), assignedToUserId, reason, actor.userId, now, ...predicate.params),
    c.env.DB.prepare(
      `UPDATE inquiries SET assigned_to_user_id = ?, handled_by_user_id = ?, updated_by = ?, updated_at = ? WHERE ${predicate.clause}`,
    ).bind(assignedToUserId, assignedToUserId, actor.userId, now, ...predicate.params),
  ];

  const results = await c.env.DB.batch(statements);
  const updateResult = results[results.length - 1];
  if (!updateResult.meta.changes) {
    await resolveConditionalWriteFailure(c.env.DB, id);
  }

  // Matches InquiriesService.assign() exactly: notifyInquiryAssigned() is
  // unconditional here (every assign() call is a (re)assignment), called
  // after the write is confirmed to have succeeded.
  await createInquiryAssignedNotification(
    c.env,
    actor,
    id,
    existing.inquiry_number,
    assignedToUserId,
  );

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'INQUIRY_ASSIGNED',
    oldValues: { assignedToUserId: existing.assigned_to_user_id },
    newValues: { assignedToUserId, reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  return c.json(ok(await toDetail(c.env.DB, row!)));
});

inquiriesRoutes.get('/inquiries/:inquiryId/assignments', ...staff, async (c) => {
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const exists = await c.env.DB.prepare('SELECT id FROM inquiries WHERE id = ?').bind(id).first();
  if (!exists) throw new InquiryNotFoundError();

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.inquiry_id, a.assigned_from_user_id, af.name AS assigned_from_name,
            a.assigned_to_user_id, at2.name AS assigned_to_name, a.assigned_at, a.reason, a.created_by
     FROM inquiry_assignments a
     LEFT JOIN users af ON af.id = a.assigned_from_user_id
     LEFT JOIN users at2 ON at2.id = a.assigned_to_user_id
     WHERE a.inquiry_id = ?
     ORDER BY a.assigned_at DESC`,
  )
    .bind(id)
    .all<{
      id: string;
      inquiry_id: string;
      assigned_from_user_id: string | null;
      assigned_from_name: string | null;
      assigned_to_user_id: string;
      assigned_to_name: string | null;
      assigned_at: string;
      reason: string | null;
      created_by: string;
    }>();

  const data = (rows.results ?? []).map((row) => ({
    id: row.id,
    inquiryId: row.inquiry_id,
    assignedFromUserId: row.assigned_from_user_id,
    assignedFrom: toUserSummary(row.assigned_from_user_id, row.assigned_from_name),
    assignedToUserId: row.assigned_to_user_id,
    assignedTo: toUserSummary(row.assigned_to_user_id, row.assigned_to_name) ?? {
      id: row.assigned_to_user_id,
      name: '',
    },
    assignedAt: row.assigned_at,
    reason: row.reason,
    createdBy: row.created_by,
  }));

  return c.json(ok(data));
});

// --- matches (Phase 40B — percentage-based matching engine) ---------------
//
// CRITICAL, hard invariant: Customer/User profile address
// (users.address/city/state/pincode) is NEVER read for matching, in
// either direction — only `cu.name`/`cu.mobile` are ever selected from
// `users` below, for display identity only. Location always comes from
// the BUYER inquiry's own city/state/pincode/locality, or the SELLER's
// *linked property's* city/state/pincode/locality (never the SELLER
// inquiry's own copied/synced location fields, even though
// deriveSyncedLocationFromProperty keeps them in sync at creation time —
// the property is the live, authoritative source, so this route always
// re-reads it directly via JOIN rather than trusting a possibly-stale
// cached copy on the inquiry).
//
// Each of the 7 dimensions (pincode/city/state/locality/propertyType/
// area/budget) is scored independently as 0-100 or `null` ("not
// comparable — excluded from the weighted average", never treated as a
// failing 0). The overall percentage is the weighted average over only
// the non-null dimensions (see computeOverallPercentage). A candidate is
// returned only if it has at least one *real* location match (pincode,
// city, state, or locality actually scoring 100) AND an overall
// percentage >= MATCH_MIN_OVERALL_PERCENTAGE — both named/explained
// below, per the approved design.

const MATCH_WEIGHTS = {
  pincode: 20,
  city: 15,
  state: 5,
  locality: 10,
  propertyType: 15,
  area: 15,
  budget: 20,
} as const;

/**
 * The minimum overall percentage a candidate must reach to be returned
 * at all — kept as one named constant (not inlined) so it can be tuned
 * later without touching the scoring logic itself, per the approved
 * design's explicit instruction.
 */
const MATCH_MIN_OVERALL_PERCENTAGE = 50;

interface MatchBreakdown {
  pincode: number | null;
  city: number | null;
  state: number | null;
  locality: number | null;
  propertyType: number | null;
  area: number | null;
  budget: number | null;
}

interface MatchLocation {
  pincode: string | null;
  city: string | null;
  state: string | null;
  locality: string | null;
}

/**
 * One side of a match comparison, always expressed as "what a BUYER
 * wants" vs "what a SELLER's property actually is" — regardless of
 * which one is the source inquiry and which is the candidate, the
 * scoring functions below always receive (buyerParty, sellerParty) in
 * that fixed order, so the formulas never need direction-specific
 * branches of their own.
 */
interface MatchParty {
  location: MatchLocation;
  propertyType: string | null;
  area: number | null;
  areaUnit: string | null;
  minBudget: number | null;
  maxBudget: number | null;
  price: number | null;
}

/** A SELLER party's data always comes from the linked PROPERTY row — never from the inquiry's own (possibly stale) copied location fields. */
function sellerPartyFromPropertyFields(row: {
  property_city: string | null;
  property_state: string | null;
  property_pincode: string | null;
  property_locality: string | null;
  property_type: string | null;
  property_area: number | null;
  property_area_unit: string | null;
  property_price_minor_units: number | null;
}): MatchParty {
  return {
    location: {
      city: row.property_city,
      state: row.property_state,
      pincode: row.property_pincode,
      locality: row.property_locality,
    },
    propertyType: row.property_type,
    area: row.property_area,
    areaUnit: row.property_area_unit,
    minBudget: null,
    maxBudget: null,
    price: row.property_price_minor_units,
  };
}

/** A BUYER party's data always comes from the INQUIRY's own fields — never from `users`/customer profile data. */
function buyerPartyFromInquiryFields(row: {
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  desired_property_type: string | null;
  desired_min_area: number | null;
  desired_area_unit: string | null;
  min_budget_minor_units: number | null;
  max_budget_minor_units: number | null;
}): MatchParty {
  return {
    location: {
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      locality: row.locality,
    },
    propertyType: row.desired_property_type,
    area: row.desired_min_area,
    areaUnit: row.desired_area_unit,
    minBudget: row.min_budget_minor_units,
    maxBudget: row.max_budget_minor_units,
    price: null,
  };
}

function normalizePropertyTypeForCompare(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Exact normalized match only — property_type stays free text (no enum), and no fuzzy/synonym matching is implemented, per the approved design. */
function scorePropertyTypeMatch(
  buyerDesired: string | null,
  sellerActual: string | null,
): number | null {
  const a = normalizePropertyTypeForCompare(buyerDesired);
  const b = normalizePropertyTypeForCompare(sellerActual);
  if (a === null || b === null) return null;
  return a === b ? 100 : 0;
}

/**
 * The buyer's desired area is a MINIMUM requirement, not an exact
 * target. Both values are converted to the canonical SQ_FT unit (see
 * utils/area-conversion.ts) before comparison — never compared across
 * mismatched units. A smaller available area than required fails
 * outright (0); a larger one still matches, with smooth diminishing
 * returns as the surplus grows (approved Phase 40A formula):
 *   ratio = available / required
 *   areaScore = 100 / (1 + log10(ratio))
 * ratio=1 -> 100, ratio=2 -> ~77, ratio=50 -> ~37 — verified against the
 * client's own worked examples during design.
 */
function scoreAreaMatch(
  requiredRaw: number | null,
  requiredUnit: string | null,
  availableRaw: number | null,
  availableUnit: string | null,
): number | null {
  if (
    requiredRaw === null ||
    requiredUnit === null ||
    availableRaw === null ||
    availableUnit === null
  ) {
    return null;
  }
  const required = toSquareFeet(requiredRaw, requiredUnit as AreaUnit);
  const available = toSquareFeet(availableRaw, availableUnit as AreaUnit);
  if (available < required) return 0;
  if (required === 0) return 100; // no real minimum stated -> trivially satisfied
  const ratio = available / required;
  return Math.round(100 / (1 + Math.log10(ratio)));
}

/**
 * Approved Phase 40A budget formula. `sellerPrice` is always the
 * seller's actual property price (never a range — no seller price range
 * is introduced by this phase); `minBudget`/`maxBudget` are the buyer's
 * stated range, either of which may be absent (today's existing data
 * will typically only have maxBudget, since minBudget is new).
 */
function scoreBudgetMatch(
  minBudget: number | null,
  maxBudget: number | null,
  sellerPrice: number | null,
): number | null {
  if (sellerPrice === null || (minBudget === null && maxBudget === null)) return null;

  if (minBudget !== null && maxBudget !== null) {
    if (sellerPrice >= minBudget && sellerPrice <= maxBudget) return 100;
    if (sellerPrice > maxBudget) {
      const overshoot = (sellerPrice - maxBudget) / maxBudget;
      return Math.max(0, Math.round(100 * (1 - overshoot)));
    }
    const undershoot = (minBudget - sellerPrice) / minBudget;
    return Math.max(0, Math.round(100 * (1 - undershoot * 0.5)));
  }

  if (maxBudget !== null) {
    // Only a maximum exists — today's common case. Preserves the exact
    // existing max-budget business meaning ("fits within budget"),
    // expressed as a percentage instead of the old binary 0/20.
    if (sellerPrice <= maxBudget) return 100;
    const overshoot = (sellerPrice - maxBudget) / maxBudget;
    return Math.max(0, Math.round(100 * (1 - overshoot)));
  }

  // Only a minimum exists (no maximum) — symmetric treatment, no upper bound to violate.
  const buyerMinBudget = minBudget as number;
  if (sellerPrice >= buyerMinBudget) return 100;
  const undershoot = (buyerMinBudget - sellerPrice) / buyerMinBudget;
  return Math.max(0, Math.round(100 * (1 - undershoot * 0.5)));
}

function computeMatchBreakdown(buyer: MatchParty, seller: MatchParty): MatchBreakdown {
  return {
    pincode: scorePincodeMatch(buyer.location.pincode, seller.location.pincode),
    city: scoreCityMatch(buyer.location.city, seller.location.city),
    state: scoreStateMatch(buyer.location.state, seller.location.state),
    locality: scoreLocalityMatch(buyer.location.locality, seller.location.locality),
    propertyType: scorePropertyTypeMatch(buyer.propertyType, seller.propertyType),
    area: scoreAreaMatch(buyer.area, buyer.areaUnit, seller.area, seller.areaUnit),
    budget: scoreBudgetMatch(buyer.minBudget, buyer.maxBudget, seller.price),
  };
}

/** Weighted average over only the non-null dimensions — a missing dimension is excluded from the denominator, never counted as a failing 0 (approved design). Returns null only when literally nothing was comparable at all. */
function computeOverallPercentage(breakdown: MatchBreakdown): number | null {
  let weightedSum = 0;
  let availableWeight = 0;
  for (const key of Object.keys(MATCH_WEIGHTS) as Array<keyof typeof MATCH_WEIGHTS>) {
    const score = breakdown[key];
    if (score === null) continue;
    weightedSum += score * MATCH_WEIGHTS[key];
    availableWeight += MATCH_WEIGHTS[key];
  }
  if (availableWeight === 0) return null;
  return Math.round(weightedSum / availableWeight);
}

/** At least one location dimension must be a REAL match (a genuine 100, not merely non-null) — a candidate with zero location alignment is never "a meaningful match", regardless of how well other dimensions score. */
function hasRealLocationMatch(breakdown: MatchBreakdown): boolean {
  return (
    breakdown.pincode === 100 ||
    breakdown.city === 100 ||
    breakdown.state === 100 ||
    breakdown.locality === 100
  );
}

interface SourceInquiryRow {
  id: string;
  type: string | null;
  property_id: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  max_budget_minor_units: number | null;
  min_budget_minor_units: number | null;
  desired_property_type: string | null;
  desired_min_area: number | null;
  desired_area_unit: string | null;
  property_city: string | null;
  property_state: string | null;
  property_pincode: string | null;
  property_locality: string | null;
  property_type: string | null;
  property_area: number | null;
  property_area_unit: string | null;
  property_price_minor_units: number | null;
}

interface MatchCandidateRow {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  property_id: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  max_budget_minor_units: number | null;
  min_budget_minor_units: number | null;
  desired_property_type: string | null;
  desired_min_area: number | null;
  desired_area_unit: string | null;
  property_city: string | null;
  property_state: string | null;
  property_pincode: string | null;
  property_locality: string | null;
  property_type: string | null;
  property_area: number | null;
  property_area_unit: string | null;
  property_price_minor_units: number | null;
}

inquiriesRoutes.get('/inquiries/:inquiryId/matches', ...staff, async (c) => {
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const source = await c.env.DB.prepare(
    `SELECT i.id, i.type, i.property_id,
            i.city, i.state, i.pincode, i.locality,
            i.max_budget_minor_units, i.min_budget_minor_units,
            i.desired_property_type, i.desired_min_area, i.desired_area_unit,
            p.city AS property_city, p.state AS property_state, p.pincode AS property_pincode,
            p.locality AS property_locality,
            p.property_type AS property_type, p.area AS property_area, p.area_unit AS property_area_unit,
            p.price_minor_units AS property_price_minor_units
     FROM inquiries i
     LEFT JOIN properties p ON p.id = i.property_id
     WHERE i.id = ?`,
  )
    .bind(id)
    .first<SourceInquiryRow>();
  if (!source) throw new InquiryNotFoundError();

  let oppositeType: 'BUYER' | 'SELLER';
  if (source.type === 'SELLER') {
    if (!source.property_id) {
      throw new ValidationError('This inquiry has no associated property to match against.');
    }
    oppositeType = 'BUYER';
  } else if (source.type === 'BUYER') {
    oppositeType = 'SELLER';
  } else {
    throw new ValidationError('Matching requires the inquiry to have type=BUYER or type=SELLER.');
  }

  // Phase 40B — PIN code is now a scored dimension, not a mandatory SQL
  // gate. No SQL-level location pre-filter replaces it in this phase;
  // candidates are the full opposite-type inquiry set, scored in JS like
  // every other dimension (see this file's Phase 40B doc note above and
  // the implementation report's Performance Considerations).
  const candidateQuery =
    oppositeType === 'SELLER'
      ? `SELECT i.id, i.customer_id, cu.name AS customer_name, cu.mobile AS customer_mobile, i.property_id,
                p.city AS property_city, p.state AS property_state, p.pincode AS property_pincode,
                p.locality AS property_locality,
                p.property_type AS property_type, p.area AS property_area, p.area_unit AS property_area_unit,
                p.price_minor_units AS property_price_minor_units,
                NULL AS city, NULL AS state, NULL AS pincode, NULL AS locality,
                NULL AS max_budget_minor_units, NULL AS min_budget_minor_units,
                NULL AS desired_property_type, NULL AS desired_min_area, NULL AS desired_area_unit
         FROM inquiries i
         LEFT JOIN users cu ON cu.id = i.customer_id
         LEFT JOIN properties p ON p.id = i.property_id
         WHERE i.id != ? AND i.type = 'SELLER'`
      : `SELECT i.id, i.customer_id, cu.name AS customer_name, cu.mobile AS customer_mobile, i.property_id,
                i.city, i.state, i.pincode, i.locality,
                i.max_budget_minor_units, i.min_budget_minor_units,
                i.desired_property_type, i.desired_min_area, i.desired_area_unit,
                NULL AS property_city, NULL AS property_state, NULL AS property_pincode,
                NULL AS property_locality,
                NULL AS property_type, NULL AS property_area, NULL AS property_area_unit,
                NULL AS property_price_minor_units
         FROM inquiries i
         LEFT JOIN users cu ON cu.id = i.customer_id
         WHERE i.id != ? AND i.type = 'BUYER'`;

  const candidates = await c.env.DB.prepare(candidateQuery).bind(id).all<MatchCandidateRow>();

  const sourceParty: MatchParty =
    source.type === 'SELLER'
      ? sellerPartyFromPropertyFields(source)
      : buyerPartyFromInquiryFields(source);

  const matches: Array<{
    inquiryId: string;
    inquiryType: 'BUYER' | 'SELLER';
    customerId: string;
    customerName: string;
    customerMobile: string | null;
    propertyId: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    locality: string | null;
    maxBudget: number | null;
    overallMatchPercentage: number;
    matchBreakdown: MatchBreakdown;
  }> = [];

  for (const candidate of candidates.results ?? []) {
    if (!candidate.customer_id || !candidate.customer_name) continue;

    const candidateParty: MatchParty =
      oppositeType === 'SELLER'
        ? sellerPartyFromPropertyFields(candidate)
        : buyerPartyFromInquiryFields(candidate);

    const buyerParty = source.type === 'BUYER' ? sourceParty : candidateParty;
    const sellerParty = source.type === 'BUYER' ? candidateParty : sourceParty;

    const breakdown = computeMatchBreakdown(buyerParty, sellerParty);
    const overall = computeOverallPercentage(breakdown);

    if (overall === null) continue; // nothing at all was comparable — not a meaningful candidate
    if (!hasRealLocationMatch(breakdown)) continue;
    if (overall < MATCH_MIN_OVERALL_PERCENTAGE) continue;

    matches.push({
      inquiryId: candidate.id,
      inquiryType: oppositeType,
      customerId: candidate.customer_id,
      customerName: candidate.customer_name,
      customerMobile: candidate.customer_mobile,
      propertyId: candidate.property_id,
      city: candidateParty.location.city,
      state: candidateParty.location.state,
      pincode: candidateParty.location.pincode,
      locality: candidateParty.location.locality,
      maxBudget: oppositeType === 'BUYER' ? minorUnitsToRupees(candidateParty.maxBudget) : null,
      overallMatchPercentage: overall,
      matchBreakdown: breakdown,
    });
  }

  matches.sort((a, b) => b.overallMatchPercentage - a.overallMatchPercentage);
  return c.json(ok(matches));
});

// --- public visibility (TOCTOU-safe) -------------------------------------------------------

inquiriesRoutes.patch('/inquiries/:inquiryId/public', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const actor: Actor = {
    userId: applicationUser.sub,
    role: applicationUser.role,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
  const id = c.req.param('inquiryId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  if (!existing) throw new InquiryNotFoundError();

  assertCanModifyInquiry(existing, actor);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.isPublic !== 'boolean') {
    throw new ValidationError('isPublic is required and must be a boolean.');
  }

  const predicate = conditionalPredicate(actor, id);
  const result = await c.env.DB.prepare(
    `UPDATE inquiries SET is_public = ?, updated_by = ?, updated_at = ? WHERE ${predicate.clause}`,
  )
    .bind(body.isPublic ? 1 : 0, actor.userId, nowIso(), ...predicate.params)
    .run();

  if (!result.meta.changes) {
    await resolveConditionalWriteFailure(c.env.DB, id);
  }

  await recordAudit(c.env.DB, {
    userId: actor.userId,
    entityType: 'INQUIRY',
    entityId: id,
    action: 'PUBLIC_STATUS_CHANGED',
    oldValues: { isPublic: Boolean(existing.is_public) },
    newValues: { isPublic: body.isPublic },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const row = await c.env.DB.prepare(`SELECT ${INQUIRY_COLUMNS} FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<InquiryRow>();
  return c.json(ok(await toDetail(c.env.DB, row!)));
});
