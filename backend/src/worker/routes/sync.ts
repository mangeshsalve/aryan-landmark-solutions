import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import { ok, ValidationError } from '../utils/response';
import { isValidUuid } from '../utils/id';
import { isValidIso8601 } from '../utils/format-validators';
import { CUSTOMER_COLUMNS, type CustomerRow, toPublicCustomer } from './customers';
import {
  PROPERTY_SELECT_WITH_OWNER,
  type PropertyRow,
  toPublicPropertyWithOwnerRow,
} from './properties';
import { INQUIRY_COLUMNS, type InquiryRow, toPublicInquiry } from './inquiries';
import { FOLLOW_UP_COLUMNS, type FollowUpRow, toPublicFollowUp } from './follow-ups';

/**
 * /api/v1/sync/* — Phase 33. Read-only incremental-sync endpoints backing
 * the Flutter offline cache. Deliberately isolated in its own module (no
 * changes to any existing CRUD route in this phase) and deliberately
 * reuses each domain's existing public row mapper and column list
 * verbatim (CUSTOMER_COLUMNS/toPublicCustomer, PROPERTY_SELECT_WITH_OWNER/
 * toPublicPropertyWithOwnerRow, INQUIRY_COLUMNS/toPublicInquiry,
 * FOLLOW_UP_COLUMNS/toPublicFollowUp) rather than inventing a second
 * response shape per entity — see the Phase 33 discovery report.
 *
 * Authorization: same requireApplicationAuth + requireRoles('ADMIN',
 * 'EMPLOYEE') pattern as every other staff route, with no additional
 * per-employee filtering — this preserves, rather than narrows, the
 * existing read-visibility boundary already confirmed for GET
 * /inquiries, /properties, /customers (none of them restrict EMPLOYEE
 * reads today; only writes are ownership-gated). Inventing a stricter
 * sync-only boundary here would be a new product decision, not a sync-
 * mechanics one, and was explicitly out of scope for this phase.
 *
 * Pagination is keyset-based on (updated_at, id) — never OFFSET. An
 * OFFSET-based page can silently skip or repeat rows when the underlying
 * table is being written to concurrently with a long-running sync (a
 * very real scenario here, since sync exists specifically to page through
 * a large, live, multi-user table); keyset pagination anchors each page
 * to an actual row's own values, so it stays correct regardless of
 * concurrent writes elsewhere. The `id` tiebreaker in both the ORDER BY
 * and the keyset predicate matters because `updated_at` alone is not
 * unique — two rows can share the same timestamp, and without the
 * tiebreaker a naive `updated_at > ?` cursor could skip or re-return rows
 * at that boundary.
 *
 * `since` (an incremental-sync watermark) and `cursor` (a same-listing
 * pagination continuation) are independent, AND-composed filters, not
 * alternatives — a client is expected to resend the same `since` across
 * every page of one incremental sync, and `cursor` alone would already
 * imply "past since" in that case, but combining both defensively keeps
 * a single request correct even if a client only sends `cursor` on later
 * pages.
 */

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseSyncPageSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new ValidationError('pageSize must be an integer.');
  if (parsed < 1) throw new ValidationError('pageSize must be >= 1.');
  if (parsed > MAX_PAGE_SIZE) throw new ValidationError(`pageSize must be <= ${MAX_PAGE_SIZE}.`);
  return parsed;
}

function parseSince(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isValidIso8601(raw)) throw new ValidationError('since must be an ISO-8601 date-time.');
  return raw;
}

interface DecodedCursor {
  ts: string;
  id: string;
}

/** Opaque cursor = base64("<timestamp>|<id>") — clients round-trip it verbatim, never parse it themselves. */
function encodeCursor(ts: string, id: string): string {
  return btoa(`${ts}|${id}`);
}

function parseCursor(raw: string | undefined): DecodedCursor | undefined {
  if (raw === undefined) return undefined;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    throw new ValidationError('cursor is invalid.');
  }
  const sepIndex = decoded.lastIndexOf('|');
  if (sepIndex === -1) throw new ValidationError('cursor is invalid.');
  const ts = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (!isValidIso8601(ts) || !isValidUuid(id)) throw new ValidationError('cursor is invalid.');
  return { ts, id };
}

/**
 * Builds the shared (since + cursor) keyset predicate for a table whose
 * timestamp/id columns are given already alias-qualified by the caller
 * (e.g. "i.updated_at"/"i.id" once a JOIN is involved) — same `p.`/`i.`
 * qualification discipline used everywhere else in this codebase once a
 * condition might run inside a JOIN query.
 */
function buildKeysetConditions(
  tsColumn: string,
  idColumn: string,
  since: string | undefined,
  cursor: DecodedCursor | undefined,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (since !== undefined) {
    conditions.push(`${tsColumn} > ?`);
    params.push(since);
  }
  if (cursor !== undefined) {
    conditions.push(`(${tsColumn} > ? OR (${tsColumn} = ? AND ${idColumn} > ?))`);
    params.push(cursor.ts, cursor.ts, cursor.id);
  }
  return { conditions, params };
}

export const syncRoutes = new Hono<AppEnv>();

// --- customers ----------------------------------------------------------

syncRoutes.get('/sync/customers', ...staff, async (c) => {
  const since = parseSince(c.req.query('since'));
  const cursor = parseCursor(c.req.query('cursor'));
  const pageSize = parseSyncPageSize(c.req.query('pageSize'));
  const serverTime = new Date().toISOString();

  const { conditions, params } = buildKeysetConditions('updated_at', 'id', since, cursor);
  const where = ['user_type = ?', ...conditions].join(' AND ');

  // Phase 39 (#9) — same correlated-subquery counts as GET /customers'
  // own list query, so the synced/cached customer shape never diverges
  // from the online one (this project relies on the two staying
  // identical — see the module doc comment above).
  const rows = await c.env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS},
            (SELECT COUNT(*) FROM properties p WHERE p.owner_customer_id = users.id) AS property_count,
            (SELECT COUNT(*) FROM inquiries i WHERE i.customer_id = users.id AND i.type = 'BUYER') AS buy_inquiry_count,
            (SELECT COUNT(*) FROM inquiries i WHERE i.customer_id = users.id AND i.type = 'SELLER') AS sell_inquiry_count
     FROM users WHERE ${where} ORDER BY updated_at ASC, id ASC LIMIT ?`,
  )
    .bind('CUSTOMER', ...params, pageSize + 1)
    .all<CustomerRow & { property_count: number; buy_inquiry_count: number; sell_inquiry_count: number }>();

  const results = rows.results ?? [];
  const hasMore = results.length > pageSize;
  const page = hasMore ? results.slice(0, pageSize) : results;
  const last = page[page.length - 1];

  const data = page.map((row) => ({
    ...toPublicCustomer(row),
    propertyCount: row.property_count,
    buyInquiryCount: row.buy_inquiry_count,
    sellInquiryCount: row.sell_inquiry_count,
  }));

  return c.json(
    ok({
      records: data,
      nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
      hasMore,
      serverTime,
    }),
  );
});

// --- properties -----------------------------------------------------------
//
// Reuses PROPERTY_SELECT_WITH_OWNER verbatim (same JOIN shape as GET
// /properties and /reports/properties/records) — no attachments are
// embedded here even though property *detail* embeds them (Phase 27):
// doing so per-row across a full properties listing would require a
// second query per row (N+1), which every earlier phase has explicitly
// avoided. This matches GET /properties' own list behavior, which also
// omits attachments for the same reason.

syncRoutes.get('/sync/properties', ...staff, async (c) => {
  const since = parseSince(c.req.query('since'));
  const cursor = parseCursor(c.req.query('cursor'));
  const pageSize = parseSyncPageSize(c.req.query('pageSize'));
  const serverTime = new Date().toISOString();

  const { conditions, params } = buildKeysetConditions('p.updated_at', 'p.id', since, cursor);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `${PROPERTY_SELECT_WITH_OWNER} ${where} ORDER BY p.updated_at ASC, p.id ASC LIMIT ?`,
  )
    .bind(...params, pageSize + 1)
    .all<PropertyRow & { owner_name: string | null; owner_mobile: string | null }>();

  const results = rows.results ?? [];
  const hasMore = results.length > pageSize;
  const page = hasMore ? results.slice(0, pageSize) : results;
  const last = page[page.length - 1];

  return c.json(
    ok({
      records: page.map(toPublicPropertyWithOwnerRow),
      nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
      hasMore,
      serverTime,
    }),
  );
});

// --- inquiries --------------------------------------------------------------
//
// Same customer/handledBy/assignedTo name JOIN as GET /inquiries' own
// list query, reused verbatim (see routes/inquiries.ts). Assignment
// history is intentionally NOT embedded here — toPublicInquiry()'s shape
// has never included it (it's only ever exposed via the separate GET
// /inquiries/:id/assignments), and this phase's instructions are
// explicit: don't add a new top-level assignments sync surface, and
// don't add unnecessary work where the existing shape doesn't already
// support it.

syncRoutes.get('/sync/inquiries', ...staff, async (c) => {
  const since = parseSince(c.req.query('since'));
  const cursor = parseCursor(c.req.query('cursor'));
  const pageSize = parseSyncPageSize(c.req.query('pageSize'));
  const serverTime = new Date().toISOString();

  const { conditions, params } = buildKeysetConditions('i.updated_at', 'i.id', since, cursor);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const cols = INQUIRY_COLUMNS.split(', ')
    .map((col) => `i.${col}`)
    .join(', ');
  // Phase 39 (#5) — same LEFT JOIN + propertyType addition as GET
  // /inquiries' own list query, so a synced/cached inquiry list can show
  // property type offline exactly like the online one (no new sync
  // architecture — same shared mapper, same pattern, just one more
  // column on top of it, on this endpoint only).
  const rows = await c.env.DB.prepare(
    `SELECT ${cols}, cu.name AS customer_name, hb.name AS handled_by_name, ao.name AS assigned_to_name, p.property_type AS property_type
     FROM inquiries i
     LEFT JOIN users cu ON cu.id = i.customer_id
     LEFT JOIN users hb ON hb.id = i.handled_by_user_id
     LEFT JOIN users ao ON ao.id = i.assigned_to_user_id
     LEFT JOIN properties p ON p.id = i.property_id
     ${where}
     ORDER BY i.updated_at ASC, i.id ASC
     LIMIT ?`,
  )
    .bind(...params, pageSize + 1)
    .all<
      InquiryRow & {
        customer_name: string | null;
        handled_by_name: string | null;
        assigned_to_name: string | null;
        property_type: string | null;
      }
    >();

  const results = rows.results ?? [];
  const hasMore = results.length > pageSize;
  const page = hasMore ? results.slice(0, pageSize) : results;
  const last = page[page.length - 1];

  const data = page.map((row) => ({
    ...toPublicInquiry(row, {
      customerName: row.customer_name,
      handledByName: row.handled_by_name,
      assignedToName: row.assigned_to_name,
    }),
    propertyType: row.property_type,
  }));

  return c.json(
    ok({
      records: data,
      nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
      hasMore,
      serverTime,
    }),
  );
});

// --- follow-ups -------------------------------------------------------------

syncRoutes.get('/sync/follow-ups', ...staff, async (c) => {
  const since = parseSince(c.req.query('since'));
  const cursor = parseCursor(c.req.query('cursor'));
  const pageSize = parseSyncPageSize(c.req.query('pageSize'));
  const serverTime = new Date().toISOString();

  const { conditions, params } = buildKeysetConditions('updated_at', 'id', since, cursor);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups ${where} ORDER BY updated_at ASC, id ASC LIMIT ?`,
  )
    .bind(...params, pageSize + 1)
    .all<FollowUpRow>();

  const results = rows.results ?? [];
  const hasMore = results.length > pageSize;
  const page = hasMore ? results.slice(0, pageSize) : results;
  const last = page[page.length - 1];

  return c.json(
    ok({
      records: page.map(toPublicFollowUp),
      nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
      hasMore,
      serverTime,
    }),
  );
});

// --- deletions (tombstone feed) ----------------------------------------------
//
// Reads audit_logs — currently written to on every PROPERTY/CUSTOMER/
// INQUIRY/FOLLOW_UP/ATTACHMENT delete (see utils/audit.ts's recordAudit()
// and follow-ups.ts's own direct batched INSERT for FOLLOW_UP_DELETED)
// but, before this phase, read by nothing. No schema change: every field
// this needs (entity_type, entity_id, created_at) already exists. Only
// entity_type/entity_id/created_at are ever selected or exposed — never
// old_values/new_values/ip_address/user_agent, per this phase's explicit
// instruction.

const DELETABLE_ENTITY_TYPES = [
  'PROPERTY',
  'CUSTOMER',
  'INQUIRY',
  'FOLLOW_UP',
  'ATTACHMENT',
] as const;
type DeletableEntityType = (typeof DELETABLE_ENTITY_TYPES)[number];

interface TombstoneRow {
  id: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
}

function parseEntityTypes(raw: string | undefined): DeletableEntityType[] {
  if (raw === undefined) return [...DELETABLE_ENTITY_TYPES];
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (values.length === 0) throw new ValidationError('entityTypes must not be empty.');
  for (const value of values) {
    if (!(DELETABLE_ENTITY_TYPES as readonly string[]).includes(value)) {
      throw new ValidationError(
        `entityTypes must be a comma-separated subset of ${DELETABLE_ENTITY_TYPES.join(', ')}.`,
      );
    }
  }
  return values as DeletableEntityType[];
}

syncRoutes.get('/sync/deletions', ...staff, async (c) => {
  const since = parseSince(c.req.query('since'));
  const cursor = parseCursor(c.req.query('cursor'));
  const pageSize = parseSyncPageSize(c.req.query('pageSize'));
  const entityTypes = parseEntityTypes(c.req.query('entityTypes'));
  const serverTime = new Date().toISOString();

  const { conditions, params } = buildKeysetConditions('created_at', 'id', since, cursor);
  const placeholders = entityTypes.map(() => '?').join(', ');
  const allConditions = [
    `entity_type IN (${placeholders})`,
    "action LIKE '%_DELETED'",
    ...conditions,
  ];
  const allParams = [...entityTypes, ...params];

  const rows = await c.env.DB.prepare(
    `SELECT id, entity_type, entity_id, created_at FROM audit_logs
     WHERE ${allConditions.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(...allParams, pageSize + 1)
    .all<TombstoneRow>();

  const results = rows.results ?? [];
  const hasMore = results.length > pageSize;
  const page = hasMore ? results.slice(0, pageSize) : results;
  const last = page[page.length - 1];

  return c.json(
    ok({
      records: page.map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        deletedAt: row.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
      hasMore,
      serverTime,
    }),
  );
});
