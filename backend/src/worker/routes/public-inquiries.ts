import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Bindings } from '../types/bindings';
import { ok, PropertyNotFoundError, RateLimitedError, ValidationError } from '../utils/response';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { isValidEmail } from '../utils/format-validators';
import { isUniqueConstraintError } from '../utils/d1-errors';
import { generateCustomerCode } from '../utils/customer-code';
import { generateInquiryNumber } from '../utils/inquiry-number';
import { createNotification } from './notifications';
import { sendPushToUser } from '../utils/push';

/**
 * Phase 45B — /api/v1/public/properties/:propertyId/inquiries and
 * /api/v1/public/inquiries: unauthenticated inquiry submission for the
 * public website, per the Phase 45A discovery report. Deliberately a
 * brand-new route file, not a relaxation of the staff-only
 * POST /inquiries (routes/inquiries.ts, untouched by this phase) — that
 * endpoint stays exactly as it was, still requiring a real ADMIN/
 * EMPLOYEE JWT.
 *
 * Design decisions carried over verbatim from Phase 45A's approved
 * discovery (not re-derived here):
 *  - `inquiries.created_by` is NOT NULL — every write here uses a single,
 *    dedicated, pre-provisioned service APPLICATION_USER (role EMPLOYEE,
 *    business user_id 'SYSTEM-WEBSITE') as the actor. EMPLOYEE, not
 *    ADMIN, specifically because the ADMIN-only Group A/B creation rule
 *    and the ADMIN-only inquiry-verification-reaper sweep
 *    (scheduled/inquiry-verification-reaper.ts, JOINs on `u.role =
 *    'ADMIN'`) both key off the *creator's* current role — an EMPLOYEE
 *    actor is structurally invisible to both, which is exactly what a
 *    website submission needs (no recording/property-type verification
 *    concept applies here at all).
 *  - Website inquiries are always created unassigned
 *    (assigned_to_user_id/handled_by_user_id = NULL) for ADMIN triage —
 *    this file does not reuse or reproduce routes/inquiries.ts's
 *    EMPLOYEE-actor self-assignment default, since that default belongs
 *    to the old staff-authenticated handler's own logic, not to this one.
 *  - `external_reference = 'WEBSITE'` tags the source using the existing
 *    free-text column rather than adding a new schema column — no
 *    migration required for this phase (see the Phase 45A report).
 *  - `submitted_at` is set immediately at creation — unlike an ADMIN
 *    quick-capture inquiry, there is no follow-up verification/finalize
 *    step in this flow, so the inquiry is genuinely complete the moment
 *    it's written.
 *  - Customers are found-or-created (never rejected as a duplicate) —
 *    deliberately different from routes/customers.ts's POST /customers,
 *    which rejects duplicates outright. That endpoint's behavior fits
 *    "staff explicitly creating a new record"; this flow's normal case
 *    is a repeat visitor, so the same underlying users-table dedup
 *    lookup (mobile OR case-insensitive email, scoped to
 *    user_type='CUSTOMER') is reused to *resolve* a customer id instead
 *    of throwing CustomerDuplicateError.
 */

const NAME_MAX = 150;
const MOBILE_MAX = 20;
const EMAIL_MAX = 255;
const MESSAGE_MAX = 1500;
const MAX_CODE_ATTEMPTS = 5;
const DUPLICATE_WINDOW_MINUTES = 5;

// Fixed business identifier for the one-time-provisioned service account
// (see scripts/production/seed-website-system-user.js) — looked up by
// this, not a hardcoded UUID, since the account's real `id` is only
// known once it's actually been created.
const SYSTEM_ACTOR_USER_ID = 'SYSTEM-WEBSITE';

interface PublicInquiryContact {
  name: string;
  mobile: string;
  email: string | null;
  message: string;
}

/** Shared validation for both endpoints: name/mobile required+trimmed, email optional+validated, message required+trimmed, all length-capped — none of these caps exist on the internal staff endpoint (a trusted-input assumption that must not carry over to an unauthenticated surface). */
function parseContactFields(body: unknown): PublicInquiryContact {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== 'string') throw new ValidationError('name is required.');
  const name = b.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new ValidationError(`name is required (1-${NAME_MAX} characters).`);
  }

  if (typeof b.mobile !== 'string') throw new ValidationError('mobile is required.');
  const mobile = b.mobile.trim();
  if (mobile.length < 1 || mobile.length > MOBILE_MAX) {
    throw new ValidationError(`mobile is required (1-${MOBILE_MAX} characters).`);
  }

  let email: string | null = null;
  if (b.email !== undefined && b.email !== null && b.email !== '') {
    if (typeof b.email !== 'string') throw new ValidationError('email must be a string.');
    const trimmedEmail = b.email.trim();
    if (trimmedEmail.length > EMAIL_MAX || !isValidEmail(trimmedEmail)) {
      throw new ValidationError(`email must be a valid email address, max ${EMAIL_MAX} characters.`);
    }
    email = trimmedEmail;
  }

  if (typeof b.message !== 'string') throw new ValidationError('message is required.');
  const message = b.message.trim();
  if (message.length < 1 || message.length > MESSAGE_MAX) {
    throw new ValidationError(`message is required (1-${MESSAGE_MAX} characters).`);
  }

  return { name, mobile, email, message };
}

async function resolveCustomerCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateCustomerCode();
    const existing = await db.prepare('SELECT id FROM users WHERE customer_code = ?').bind(candidate).first();
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique customer code after several attempts.');
}

async function resolveInquiryNumber(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateInquiryNumber();
    const existing = await db.prepare('SELECT id FROM inquiries WHERE inquiry_number = ?').bind(candidate).first();
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique inquiry number after several attempts.');
}

/**
 * Looks up the pre-provisioned service actor. Never inserts NULL into
 * inquiries.created_by (NOT NULL) and never falls back to a guessed
 * actor — if the account hasn't been provisioned yet, this fails loudly
 * server-side (console.error, never shown to the visitor) and the
 * request surfaces as the same generic INTERNAL_ERROR envelope every
 * other unexpected failure in this Worker already produces (see
 * middleware/error.ts) — no internal detail is leaked either way.
 */
async function getSystemActorUserId(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM users WHERE user_id = ? AND user_type = 'APPLICATION_USER'")
    .bind(SYSTEM_ACTOR_USER_ID)
    .first<{ id: string }>();
  if (!row) {
    console.error('Public inquiry: system actor user is not provisioned', {
      expectedUserId: SYSTEM_ACTOR_USER_ID,
    });
    throw new Error('Public inquiry submission is not currently available.');
  }
  return row.id;
}

/**
 * Phase 45F (L-1): explicit match precedence, resolved as two sequential
 * exact lookups rather than one `mobile = ? OR LOWER(email) = LOWER(?)`
 * query. That combined query could match two different CUSTOMER rows
 * (mobile belongs to one customer, email belongs to another) with no
 * documented tie-break — SQLite happened to return a stable answer, but
 * only as an accident of row order, not because the query expressed any
 * intended precedence.
 *
 * Intended precedence (now explicit):
 *   1. Exact mobile match wins, if one exists — checked first, and if
 *      found, the email match (if any, on a *different* row) is never
 *      even queried, let alone touched.
 *   2. Otherwise, case-insensitive email match.
 *   3. Otherwise, no existing customer (findOrCreateCustomer creates one).
 */
async function findExistingCustomerId(
  db: D1Database,
  contact: Pick<PublicInquiryContact, 'mobile' | 'email'>,
): Promise<string | null> {
  const byMobile = await db
    .prepare("SELECT id FROM users WHERE user_type = 'CUSTOMER' AND mobile = ?")
    .bind(contact.mobile)
    .first<{ id: string }>();
  if (byMobile) return byMobile.id;

  if (contact.email) {
    const byEmail = await db
      .prepare("SELECT id FROM users WHERE user_type = 'CUSTOMER' AND LOWER(email) = LOWER(?)")
      .bind(contact.email)
      .first<{ id: string }>();
    if (byEmail) return byEmail.id;
  }

  return null;
}

/** Finds an existing CUSTOMER via findExistingCustomerId's mobile-then-email precedence, or creates one. Never rejects — see this file's header comment for why that differs from POST /customers. */
async function findOrCreateCustomer(
  db: D1Database,
  actorUserId: string,
  contact: Pick<PublicInquiryContact, 'name' | 'mobile' | 'email'>,
): Promise<string> {
  const existingId = await findExistingCustomerId(db, contact);
  if (existingId) return existingId;

  const id = newId();
  const now = nowIso();
  const customerCode = await resolveCustomerCode(db);

  try {
    await db
      .prepare(
        `INSERT INTO users (
          id, user_type, role, password_hash, user_id, name, email, mobile, alternate_mobile,
          address, city, state, pincode, created_at, updated_at, created_by, updated_by, customer_code
        ) VALUES (?, 'CUSTOMER', NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(id, contact.name, contact.email, contact.mobile, now, now, actorUserId, actorUserId, customerCode)
      .run();
    return id;
  } catch (err) {
    // Only `email` is DB-unique (mobile is index-only) — a collision here
    // means someone else's matching row was created between our lookup
    // and this insert (or an existing customer already owns this email
    // under a different mobile). Re-resolve rather than fail the
    // visitor's submission.
    if (isUniqueConstraintError(err)) {
      const retry = await findExistingCustomerId(db, contact);
      if (retry) return retry;
    }
    throw err;
  }
}

/**
 * Phase 45F (M-1): atomic duplicate-guarded insert, replacing the former
 * two-step `hasRecentDuplicate()` SELECT followed by a separate
 * `insertPublicInquiry()` INSERT. That two-step shape was not atomic:
 * two nearly-simultaneous requests from the same visitor could both pass
 * the SELECT (neither had committed yet) and both go on to INSERT,
 * producing two rows instead of the intended single idempotent one.
 *
 * The fix folds the check and the write into a single SQL statement —
 * `INSERT ... SELECT <values> WHERE NOT EXISTS (<duplicate predicate>)`
 * — so the duplicate check and the row creation are one indivisible unit
 * of work as far as SQLite/D1 is concerned, not two separate round trips
 * with a gap between them. This is the same `meta.changes`-checked
 * conditional-write idiom already used elsewhere in this codebase for
 * exactly this reason (see routes/inquiries.ts's conditionalPredicate/
 * resolveConditionalWriteFailure and scheduled/follow-up-reminders.ts's
 * claim-via-conditional-UPDATE, whose own comment already documents that
 * "SQLite/D1 serializes writes to a single row, so at most one concurrent
 * invocation can ever see meta.changes === 1"). D1 is built on SQLite,
 * which only ever allows one writer to a given database at a time — two
 * concurrent requests' INSERT statements against the same database
 * cannot execute concurrently or interleave; one fully completes (its
 * NOT EXISTS check and its insert together) before the other's NOT
 * EXISTS check runs, so the second one correctly sees the first's row
 * and inserts nothing. `result.meta.changes` (0 or 1) tells the caller,
 * without a second query, whether this call was the one that created the
 * row (`created: true`) or was blocked as a duplicate (`created: false`)
 * — a real transaction/batch (`db.batch()`) was considered but rejected:
 * D1's batch runs a fixed list of statements with no way for one
 * statement's result to conditionally skip a later one, so it cannot
 * express "insert only if not already present" on its own — the single
 * INSERT...SELECT...WHERE NOT EXISTS statement is the smaller, more
 * direct primitive that D1's existing (SQLite) engine already evaluates
 * atomically, with no new locking mechanism invented.
 *
 * Business rule preserved exactly (only the enforcement mechanism
 * changed):
 *   PROPERTY: same customer + same property within 5 minutes.
 *   GENERAL:  same customer + same type + property_id NULL within 5 minutes.
 */
async function insertPublicInquiryIfNotDuplicate(
  db: D1Database,
  params: {
    actorUserId: string;
    customerId: string;
    propertyId: string | null;
    type: 'BUYER' | 'SELLER';
    message: string;
  },
): Promise<{ created: true; id: string; inquiryNumber: string } | { created: false }> {
  const inquiryNumber = await resolveInquiryNumber(db);
  const id = newId();
  const now = nowIso();
  const windowStart = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60_000).toISOString();

  const guardConditions = ['customer_id = ?', 'created_at >= ?'];
  const guardParams: unknown[] = [params.customerId, windowStart];
  if (params.propertyId) {
    guardConditions.push('property_id = ?');
    guardParams.push(params.propertyId);
  } else {
    guardConditions.push('property_id IS NULL', 'type = ?');
    guardParams.push(params.type);
  }

  const result = await db
    .prepare(
      `INSERT INTO inquiries (
        id, inquiry_number, customer_id, property_id, type, priority, status, external_reference,
        handled_by_user_id, assigned_to_user_id, remarks, is_public, city, state, pincode, locality,
        max_budget_minor_units, min_budget_minor_units, desired_property_type, desired_min_area, desired_area_unit,
        submitted_at, created_at, updated_at, created_by, updated_by
      )
      SELECT ?, ?, ?, ?, ?, 'MEDIUM', 'NEW', 'WEBSITE', NULL, NULL, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM inquiries WHERE ${guardConditions.join(' AND ')})`,
    )
    .bind(
      id,
      inquiryNumber,
      params.customerId,
      params.propertyId,
      params.type,
      params.message,
      now,
      now,
      now,
      params.actorUserId,
      params.actorUserId,
      ...guardParams,
    )
    .run();

  if (!result.meta.changes) {
    return { created: false };
  }
  return { created: true, id, inquiryNumber };
}

/**
 * Notifies every currently-ACTIVE ADMIN — the role with system-wide
 * unassigned-inquiry triage authority elsewhere in this codebase (the
 * Group A/B creation rule and the existing assignment-notification path
 * are both already ADMIN-gated; no EMPLOYEE broadcast notification
 * exists anywhere in this codebase to model this on instead). Reuses the
 * exact same primitives the rest of the app already uses
 * (createNotification, sendPushToUser) — not a new notification system.
 * Fully isolated: any failure here is logged and swallowed, never
 * allowed to fail the inquiry submission that already committed.
 */
async function notifyAdminsOfWebsiteInquiry(
  env: Bindings,
  params: { inquiryId: string; inquiryNumber: string; propertyId: string | null },
): Promise<void> {
  try {
    const admins = await env.DB.prepare(
      "SELECT id FROM users WHERE user_type = 'APPLICATION_USER' AND role = 'ADMIN' AND status = 'ACTIVE'",
    ).all<{ id: string }>();
    const recipients = admins.results ?? [];
    if (recipients.length === 0) {
      console.error('Public inquiry: no ACTIVE ADMIN found to notify', { inquiryId: params.inquiryId });
      return;
    }

    const title = 'New website inquiry';
    const message = params.propertyId
      ? `A website visitor enquired about a property (${params.inquiryNumber}).`
      : `A website visitor submitted a general inquiry (${params.inquiryNumber}).`;

    for (const admin of recipients) {
      try {
        const notificationId = await createNotification(env.DB, {
          userId: admin.id,
          type: 'WEBSITE_INQUIRY_RECEIVED',
          title,
          message,
          entityType: 'INQUIRY',
          entityId: params.inquiryId,
        });
        await sendPushToUser(env, {
          userId: admin.id,
          notificationId,
          entityType: 'INQUIRY',
          entityId: params.inquiryId,
          title,
          message,
          logContext: 'Website inquiry push',
        });
      } catch (error) {
        console.error('Public inquiry: failed to notify one admin', {
          inquiryId: params.inquiryId,
          adminId: admin.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    console.error('Public inquiry: failed to notify admins', {
      inquiryId: params.inquiryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Same pattern as routes/auth.ts's enforceLoginRateLimit — duplicated rather than imported/exported to keep that file's login-specific surface untouched by this phase. */
async function enforcePublicInquiryRateLimit(limiter: RateLimit, c: Context<AppEnv>): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: ip });
  // Phase 45F (M-2): RateLimitedError's default message is login-specific;
  // pass an inquiry-specific one here instead. Same RATE_LIMITED code and
  // 429 status as before — only the text changes.
  if (!success) throw new RateLimitedError('Too many inquiry requests. Please wait a moment and try again.');
}

const SUCCESS_MESSAGE = 'Thank you. Your inquiry has been submitted successfully.';

export const publicInquiriesRoutes = new Hono<AppEnv>();

// Narrow CORS, scoped to these two exact path patterns only — NOT a bare
// '*', per the hard lesson already learned and documented in
// public-properties.ts (every router in this app is mounted at the same
// root, so an unscoped '*' would leak onto authenticated routes too).
const publicCors = cors({ origin: '*', allowMethods: ['POST'] });
publicInquiriesRoutes.use('/public/inquiries', publicCors);
publicInquiriesRoutes.use('/public/properties/:propertyId/inquiries', publicCors);

/**
 * POST /public/properties/:propertyId/inquiries — "I'm Interested" on a
 * property detail page. type is always BUYER, hardcoded — never read
 * from the request body at all (and explicitly rejected if present, the
 * same "explicitly forbidden field" convention routes/properties.ts's
 * parsePropertyBody already uses for status/isPublic on create).
 */
publicInquiriesRoutes.post('/public/properties/:propertyId/inquiries', async (c) => {
  await enforcePublicInquiryRateLimit(c.env.PUBLIC_INQUIRY_RATE_LIMITER, c);

  const propertyId = c.req.param('propertyId');
  if (!isValidUuid(propertyId)) throw new ValidationError('Validation failed (uuid is expected)');

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && body.type !== undefined) {
    throw new ValidationError('type is not accepted for a property-specific inquiry (always BUYER).');
  }
  const contact = parseContactFields(body);

  // Same visibility gate as public-properties.ts, re-checked here
  // independently — a nonexistent property and a private/SOLD/ON_HOLD/
  // INACTIVE one must be indistinguishable from each other to the caller.
  const property = await c.env.DB.prepare(
    "SELECT id FROM properties WHERE id = ? AND is_public = 1 AND status = 'AVAILABLE'",
  )
    .bind(propertyId)
    .first<{ id: string }>();
  if (!property) throw new PropertyNotFoundError();

  const actorUserId = await getSystemActorUserId(c.env.DB);
  const customerId = await findOrCreateCustomer(c.env.DB, actorUserId, contact);

  const insertResult = await insertPublicInquiryIfNotDuplicate(c.env.DB, {
    actorUserId,
    customerId,
    propertyId,
    type: 'BUYER',
    message: contact.message,
  });

  if (!insertResult.created) {
    return c.json(ok({ message: SUCCESS_MESSAGE }));
  }

  await notifyAdminsOfWebsiteInquiry(c.env, {
    inquiryId: insertResult.id,
    inquiryNumber: insertResult.inquiryNumber,
    propertyId,
  });

  return c.json(ok({ message: SUCCESS_MESSAGE }), 201);
});

/**
 * POST /public/inquiries — the Contact Us flow. No property; the
 * visitor explicitly picks BUYER or SELLER.
 */
publicInquiriesRoutes.post('/public/inquiries', async (c) => {
  await enforcePublicInquiryRateLimit(c.env.PUBLIC_INQUIRY_RATE_LIMITER, c);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const contact = parseContactFields(body);

  const rawType = body?.type;
  if (typeof rawType !== 'string' || (rawType !== 'BUYER' && rawType !== 'SELLER')) {
    throw new ValidationError('type is required and must be one of BUYER, SELLER.');
  }

  const actorUserId = await getSystemActorUserId(c.env.DB);
  const customerId = await findOrCreateCustomer(c.env.DB, actorUserId, contact);

  const insertResult = await insertPublicInquiryIfNotDuplicate(c.env.DB, {
    actorUserId,
    customerId,
    propertyId: null,
    type: rawType,
    message: contact.message,
  });

  if (!insertResult.created) {
    return c.json(ok({ message: SUCCESS_MESSAGE }));
  }

  await notifyAdminsOfWebsiteInquiry(c.env, {
    inquiryId: insertResult.id,
    inquiryNumber: insertResult.inquiryNumber,
    propertyId: null,
  });

  return c.json(ok({ message: SUCCESS_MESSAGE }), 201);
});
