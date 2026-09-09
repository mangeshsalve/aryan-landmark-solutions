import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import {
  ForbiddenRoleError,
  ok,
  okPaginated,
  PropertyDuplicateError,
  PropertyNotFoundError,
  ValidationError,
} from '../utils/response';
import { isUniqueConstraintError } from '../utils/d1-errors';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { recordAudit } from '../utils/audit';
import { minorUnitsToRupees, rupeesToMinorUnits } from '../utils/money';
import { generatePropertyCode } from '../utils/property-code';
import { normalizeLocationValue } from '../utils/location';
import { parsePagination } from '../utils/pagination';
import { isValidMapUrl } from '../utils/format-validators';
import {
  ATTACHMENT_COLUMNS,
  AttachmentRow,
  removeAttachmentInternal,
  toPublicAttachment,
} from './attachments';

/**
 * /api/v1/properties — ported field-for-field from PropertiesController/
 * PropertiesService. Source of truth verified by direct read this phase:
 * properties.controller.ts, properties.service.ts, property.mapper.ts,
 * property-code.util.ts, create/update/list DTOs, and
 * location-match.util.ts's deriveSyncedLocationFromProperty (for the
 * SELLER-inquiry location-sync side effect on update).
 */

const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'];
export const PROPERTY_AREA_UNITS = ['SQ_FT', 'SQ_YD', 'SQ_M', 'ACRE', 'GUNTHA', 'HECTARE'];
const PROPERTY_STATUSES = ['AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE'];
const MAX_PROPERTY_CODE_ATTEMPTS = 5;

export interface PropertyRow {
  id: string;
  property_code: string;
  property_type: string;
  category: string;
  area: number | null;
  area_unit: string | null;
  price_minor_units: number | null;
  price_unit: string | null;
  gat_no_details: string | null;
  description: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  map_url: string | null;
  status: string;
  is_public: number | null;
  owner_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Matches components.schemas.Property in docs/api/openapi.yaml exactly —
 * `price` is the external field name; the D1 storage split
 * (price_minor_units) never leaks into the response, matching Phase 1's
 * "external API contract unchanged" requirement.
 *
 * Exported for reuse by routes/inquiries.ts's inquiry-detail view
 * (property: PublicProperty | null) — one canonical money-conversion
 * path, per this phase's explicit "do not duplicate money logic"
 * instruction.
 *
 * Phase 26: `owner` mirrors routes/inquiries.ts's toPublicInquiry()
 * pattern exactly — both the flat FK (`ownerCustomerId`, for forms/
 * updates) and a small nested summary (`owner`, for display) are
 * returned side by side, the same shape `customerId`+`customer` already
 * use on Inquiry. `ownerName`/`ownerMobile` are optional params so this
 * function stays usable from call sites that haven't joined `users`
 * (e.g. the POST/PATCH re-fetch when no owner is set — passing them only
 * when `owner_customer_id` is non-null keeps the caller's JOIN
 * mandatory only where an owner can actually be present).
 */
export function toPublicProperty(
  row: PropertyRow,
  owner?: { name: string; mobile: string | null } | null,
) {
  return {
    id: row.id,
    propertyCode: row.property_code,
    propertyType: row.property_type,
    category: row.category,
    area: row.area,
    areaUnit: row.area_unit,
    price: minorUnitsToRupees(row.price_minor_units),
    priceUnit: row.price_unit,
    gatNoDetails: row.gat_no_details,
    description: row.description,
    address: row.address,
    locality: row.locality,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    mapUrl: row.map_url,
    status: row.status,
    isPublic: Boolean(row.is_public),
    ownerCustomerId: row.owner_customer_id,
    owner:
      row.owner_customer_id && owner
        ? { id: row.owner_customer_id, name: owner.name, mobile: owner.mobile }
        : null,
  };
}

export const PROPERTY_COLUMNS =
  'id, property_code, property_type, category, area, area_unit, price_minor_units, price_unit, gat_no_details, description, address, locality, city, state, pincode, latitude, longitude, map_url, status, is_public, owner_customer_id, created_at, updated_at';

/**
 * Phase 26: joins `properties` to `users` for the owner's display name/
 * mobile in one query — reused by both GET /properties (list) and
 * GET /properties/:propertyId (detail) so neither does an N+1 lookup per
 * row. `p.`-qualifies every PROPERTY_COLUMNS column (same reasoning as
 * routes/inquiries.ts's list endpoint aliasing INQUIRY_COLUMNS with
 * `i.` once a JOIN is introduced).
 */
export const PROPERTY_SELECT_WITH_OWNER = `SELECT ${PROPERTY_COLUMNS.split(', ')
  .map((col) => `p.${col}`)
  .join(', ')}, u.name AS owner_name, u.mobile AS owner_mobile
   FROM properties p LEFT JOIN users u ON u.id = p.owner_customer_id`;

export function toPublicPropertyWithOwnerRow(
  row: PropertyRow & { owner_name: string | null; owner_mobile: string | null },
) {
  return toPublicProperty(
    row,
    row.owner_name ? { name: row.owner_name, mobile: row.owner_mobile } : null,
  );
}

interface PropertyInput {
  propertyCode?: string;
  propertyType?: string;
  category?: string;
  area?: number;
  areaUnit?: string;
  price?: number;
  gatNoDetails?: string;
  description?: string;
  address?: string;
  locality?: string;
  city?: string;
  state?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  mapUrl?: string;
  status?: string;
  isPublic?: boolean;
}

/**
 * Phase 26: `ownerCustomerId` is reported separately from `PropertyInput`
 * (an `{provided, value}` pair, not just an optional field on the
 * result), the same tri-state pattern routes/inquiries.ts's
 * parseInquiryBody() already uses for `assignedToUserId` — an explicit
 * `null` must mean "clear the owner", distinguishable from the field
 * being absent entirely ("no change" on update / "no owner" on create),
 * which a plain `string | undefined` field can't represent.
 */
interface ParsedPropertyBody {
  input: PropertyInput;
  ownerCustomerIdProvided: boolean;
  ownerCustomerIdValue: string | null;
}

/** Matches CreatePropertyDto exactly (requireRequired=true) / UpdatePropertyDto (requireRequired=false, plus status/isPublic). */
function parsePropertyBody(
  body: unknown,
  requireRequired: boolean,
  allowStatusAndPublic: boolean,
): ParsedPropertyBody {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;
  const result: PropertyInput = {};

  if (b.propertyCode !== undefined) {
    if (typeof b.propertyCode !== 'string' || b.propertyCode.length > 50) {
      throw new ValidationError('propertyCode must be a string, max 50 characters.');
    }
    result.propertyCode = b.propertyCode;
  }

  if (b.propertyType !== undefined || requireRequired) {
    if (
      typeof b.propertyType !== 'string' ||
      b.propertyType.length < 1 ||
      b.propertyType.length > 50
    ) {
      throw new ValidationError('propertyType is required (1-50 characters).');
    }
    result.propertyType = b.propertyType;
  }

  if (b.category !== undefined || requireRequired) {
    if (typeof b.category !== 'string' || !PROPERTY_CATEGORIES.includes(b.category)) {
      throw new ValidationError(`category must be one of ${PROPERTY_CATEGORIES.join(', ')}.`);
    }
    result.category = b.category;
  }

  if (b.area !== undefined) {
    if (typeof b.area !== 'number' || !Number.isFinite(b.area) || b.area < 0) {
      throw new ValidationError('area must be a number >= 0.');
    }
    result.area = b.area;
  }
  if (b.areaUnit !== undefined) {
    if (typeof b.areaUnit !== 'string' || !PROPERTY_AREA_UNITS.includes(b.areaUnit)) {
      throw new ValidationError(`areaUnit must be one of ${PROPERTY_AREA_UNITS.join(', ')}.`);
    }
    result.areaUnit = b.areaUnit;
  }
  if (b.price !== undefined) {
    if (typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < 0) {
      throw new ValidationError('price must be a number >= 0.');
    }
    result.price = b.price;
  }
  if (b.gatNoDetails !== undefined) {
    if (typeof b.gatNoDetails !== 'string' || b.gatNoDetails.length > 255) {
      throw new ValidationError('gatNoDetails must be a string, max 255 characters.');
    }
    result.gatNoDetails = b.gatNoDetails;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string')
      throw new ValidationError('description must be a string.');
    result.description = b.description;
  }
  if (b.address !== undefined) {
    if (typeof b.address !== 'string') throw new ValidationError('address must be a string.');
    result.address = b.address;
  }
  if (b.locality !== undefined) {
    if (typeof b.locality !== 'string' || b.locality.length > 150) {
      throw new ValidationError('locality must be a string, max 150 characters.');
    }
    result.locality = b.locality;
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
  if (b.latitude !== undefined) {
    if (
      typeof b.latitude !== 'number' ||
      !Number.isFinite(b.latitude) ||
      b.latitude < -90 ||
      b.latitude > 90
    ) {
      throw new ValidationError('latitude must be a number between -90 and 90.');
    }
    result.latitude = b.latitude;
  }
  if (b.longitude !== undefined) {
    if (
      typeof b.longitude !== 'number' ||
      !Number.isFinite(b.longitude) ||
      b.longitude < -180 ||
      b.longitude > 180
    ) {
      throw new ValidationError('longitude must be a number between -180 and 180.');
    }
    result.longitude = b.longitude;
  }
  if (b.mapUrl !== undefined) {
    // Phase 9: byte-perfect parity with class-validator's @IsUrl()
    // (delegates to validator.js's isURL()) — was previously `new
    // URL()` try/catch, which diverged in both directions: e.g. it
    // rejected a bare "example.com" (no protocol) that the real DTO
    // accepts (require_protocol defaults to false), and accepted things
    // the real DTO rejects, like "javascript:alert(1)" or a trailing-dot
    // host.
    if (typeof b.mapUrl !== 'string' || !isValidMapUrl(b.mapUrl)) {
      throw new ValidationError('mapUrl must be a valid URL.');
    }
    result.mapUrl = b.mapUrl;
  }

  if (allowStatusAndPublic) {
    if (b.status !== undefined) {
      if (typeof b.status !== 'string' || !PROPERTY_STATUSES.includes(b.status)) {
        throw new ValidationError(`status must be one of ${PROPERTY_STATUSES.join(', ')}.`);
      }
      result.status = b.status;
    }
    if (b.isPublic !== undefined) {
      if (typeof b.isPublic !== 'boolean') throw new ValidationError('isPublic must be a boolean.');
      result.isPublic = b.isPublic;
    }
  } else if (b.status !== undefined || b.isPublic !== undefined) {
    // CreatePropertyDto declares neither field — forbidNonWhitelisted
    // would reject these on the real backend; reproduce that rejection.
    throw new ValidationError('status and isPublic are not accepted on create.');
  }

  // Phase 26: ownerCustomerId — an explicit `null` clears the owner and
  // is tracked as "provided" (see ParsedPropertyBody's doc comment); a
  // present-but-invalid value is rejected outright, never silently
  // coerced to null (explicit instruction — an unrecognized id must not
  // be quietly treated the same as "no owner"). Existence + CUSTOMER-type
  // checking happens in the route handler (assertValidOwnerCustomer
  // below), not here, since that needs DB access this function doesn't have.
  let ownerCustomerIdProvided = false;
  let ownerCustomerIdValue: string | null = null;
  if (b.ownerCustomerId !== undefined) {
    ownerCustomerIdProvided = true;
    if (b.ownerCustomerId === null) {
      ownerCustomerIdValue = null;
    } else if (typeof b.ownerCustomerId === 'string' && isValidUuid(b.ownerCustomerId)) {
      ownerCustomerIdValue = b.ownerCustomerId;
    } else {
      throw new ValidationError('ownerCustomerId must be a UUID or null.');
    }
  }

  return { input: result, ownerCustomerIdProvided, ownerCustomerIdValue };
}

/**
 * Phase 26: enforces "must reference an existing CUSTOMER" — the same
 * kind of relationship-existence check routes/inquiries.ts's
 * validateRelationshipAndResource() does for propertyId/inquiryId (a 400
 * ValidationError for both "doesn't exist" and "wrong type", not a 404 —
 * matching that established precedent, since the request itself is what's
 * invalid). No CHECK constraint enforces the CUSTOMER-only rule at the
 * schema level (see migrations/0002_add_property_owner.sql's own doc
 * comment on why), so this is the one place it's enforced.
 */
async function assertValidOwnerCustomer(db: D1Database, ownerCustomerId: string): Promise<void> {
  const user = await db
    .prepare('SELECT user_type FROM users WHERE id = ?')
    .bind(ownerCustomerId)
    .first<{
      user_type: string;
    }>();
  if (!user) {
    throw new ValidationError('ownerCustomerId does not reference an existing user.');
  }
  if (user.user_type !== 'CUSTOMER') {
    throw new ValidationError(
      'ownerCustomerId must reference a CUSTOMER user, not an ADMIN, EMPLOYEE, or MASTER.',
    );
  }
}

async function resolveCreateCode(db: D1Database, requested?: string): Promise<string> {
  if (requested) {
    const existing = await db
      .prepare('SELECT id FROM properties WHERE property_code = ?')
      .bind(requested)
      .first();
    if (existing) throw new PropertyDuplicateError();
    return requested;
  }
  for (let attempt = 0; attempt < MAX_PROPERTY_CODE_ATTEMPTS; attempt++) {
    const candidate = generatePropertyCode();
    const existing = await db
      .prepare('SELECT id FROM properties WHERE property_code = ?')
      .bind(candidate)
      .first();
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate a unique property code after several attempts.');
}

export const propertiesRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;
const adminOnly = [requireApplicationAuth, requireRoles('ADMIN')] as const;

propertiesRoutes.get('/properties', ...staff, async (c) => {
  const { page, pageSize } = parsePagination(c);
  const status = c.req.query('status');
  const category = c.req.query('category');
  const city = c.req.query('city');
  const search = c.req.query('search')?.trim();

  if (status && !PROPERTY_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${PROPERTY_STATUSES.join(', ')}.`);
  }
  if (category && !PROPERTY_CATEGORIES.includes(category)) {
    throw new ValidationError(`category must be one of ${PROPERTY_CATEGORIES.join(', ')}.`);
  }

  // Phase 26: every condition/order-by column is qualified with `p.` —
  // GET /properties/:propertyId's own comment explains why this is not
  // optional once PROPERTY_SELECT_WITH_OWNER's LEFT JOIN to `users` is in
  // play: `users` also has status/city/address/created_at columns, so an
  // unqualified reference here would be genuinely ambiguous to D1/SQLite,
  // not just a style choice (the exact bug class fixed in the Phase 22
  // customer report's date-range query).
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push('p.status = ?');
    params.push(status);
  }
  if (category) {
    conditions.push('p.category = ?');
    params.push(category);
  }
  if (city) {
    conditions.push('LOWER(p.city) = LOWER(?)');
    params.push(city);
  }
  if (search && search.length > 0) {
    // Matches PropertiesService.list()'s OR clause exactly: propertyCode/
    // propertyType/locality/address, case-insensitive contains. Notably
    // does NOT include city — city is a separate exact-match filter.
    conditions.push(
      '(LOWER(p.property_code) LIKE ? OR LOWER(p.property_type) LIKE ? OR LOWER(p.locality) LIKE ? OR LOWER(p.address) LIKE ?)',
    );
    const term = `%${search.toLowerCase()}%`;
    params.push(term, term, term, term);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // No owner data is needed to count rows, so this stays join-free — but
  // it still aliases `properties p` so the same `p.`-qualified `where`
  // string built above can be reused verbatim for both this query and
  // the data query below, rather than maintaining two WHERE clauses.
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM properties p ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const rows = await c.env.DB.prepare(
    `${PROPERTY_SELECT_WITH_OWNER} ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return c.json(
    okPaginated(
      (
        rows.results as unknown as Array<
          PropertyRow & { owner_name: string | null; owner_mobile: string | null }
        >
      ).map(toPublicPropertyWithOwnerRow),
      {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    ),
  );
});

/**
 * Phase 27 — embeds `attachments` in the detail response, matching
 * openapi.yaml's already-documented PropertyDetailResponse schema
 * (Property + attachments: Attachment[]) that this route had never
 * actually implemented (see the Phase 27 discovery report: Flutter's
 * Property.fromJson() was written correctly against that documented
 * contract, but the field never arrived, so photos/documents were
 * always empty regardless of upload success). One extra query for the
 * single property being fetched — not a per-row cost, so this does not
 * introduce N+1 on GET /properties (list), which is deliberately left
 * unchanged and still returns no attachments field, matching
 * PropertyListResponse. Same query shape (columns, ordering) as
 * routes/inquiries.ts's toDetail() uses for its own embedded
 * attachments — one canonical pattern, not a second one invented here.
 */
propertiesRoutes.get('/properties/:propertyId', ...staff, async (c) => {
  const id = c.req.param('propertyId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const [row, attachmentRows] = await Promise.all([
    c.env.DB.prepare(`${PROPERTY_SELECT_WITH_OWNER} WHERE p.id = ?`)
      .bind(id)
      .first<PropertyRow & { owner_name: string | null; owner_mobile: string | null }>(),
    c.env.DB.prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE property_id = ? ORDER BY display_order ASC, created_at DESC`,
    )
      .bind(id)
      .all<AttachmentRow>(),
  ]);
  if (!row) throw new PropertyNotFoundError();

  return c.json(
    ok({
      ...toPublicPropertyWithOwnerRow(row),
      attachments: (attachmentRows.results ?? []).map(toPublicAttachment),
    }),
  );
});

propertiesRoutes.post('/properties', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const { input, ownerCustomerIdProvided, ownerCustomerIdValue } = parsePropertyBody(
    await c.req.json().catch(() => null),
    true,
    false,
  );
  if (ownerCustomerIdProvided && ownerCustomerIdValue !== null) {
    await assertValidOwnerCustomer(c.env.DB, ownerCustomerIdValue);
  }

  const propertyCode = await resolveCreateCode(c.env.DB, input.propertyCode);
  const priceMinorUnits = rupeesToMinorUnits(input.price ?? null);
  const id = newId();
  const now = nowIso();

  try {
    await c.env.DB.prepare(
      `INSERT INTO properties (
        id, property_code, property_type, category, area, area_unit, price_minor_units, price_unit,
        gat_no_details, description, address, locality, city, state, pincode, latitude, longitude,
        map_url, status, is_public, owner_customer_id, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', NULL, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        propertyCode,
        input.propertyType,
        input.category,
        input.area ?? null,
        input.areaUnit ?? null,
        priceMinorUnits,
        input.gatNoDetails ?? null,
        input.description ?? null,
        input.address ?? null,
        input.locality ?? null,
        input.city ?? null,
        input.state ?? null,
        input.pincode ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.mapUrl ?? null,
        ownerCustomerIdValue,
        now,
        now,
        applicationUser.sub,
        applicationUser.sub,
      )
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new PropertyDuplicateError();
    throw err;
  }

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'PROPERTY',
    entityId: id,
    action: 'PROPERTY_CREATED',
    newValues: { ...input, propertyCode, ownerCustomerId: ownerCustomerIdValue },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(`${PROPERTY_SELECT_WITH_OWNER} WHERE p.id = ?`)
    .bind(id)
    .first<PropertyRow & { owner_name: string | null; owner_mobile: string | null }>();
  return c.json(ok(toPublicPropertyWithOwnerRow(row!)), 201);
});

propertiesRoutes.patch('/properties/:propertyId', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('propertyId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ?`)
    .bind(id)
    .first<PropertyRow>();
  if (!existing) throw new PropertyNotFoundError();

  const { input, ownerCustomerIdProvided, ownerCustomerIdValue } = parsePropertyBody(
    await c.req.json().catch(() => null),
    false,
    true,
  );
  if (ownerCustomerIdProvided && ownerCustomerIdValue !== null) {
    await assertValidOwnerCustomer(c.env.DB, ownerCustomerIdValue);
  }

  // isPublic is ADMIN-only — role comes from the verified JWT, never the
  // request body. Matches PropertiesService.update() exactly.
  if (input.isPublic !== undefined && applicationUser.role !== 'ADMIN') {
    throw new ForbiddenRoleError();
  }

  if (input.propertyCode && input.propertyCode !== existing.property_code) {
    const conflict = await c.env.DB.prepare('SELECT id FROM properties WHERE property_code = ?')
      .bind(input.propertyCode)
      .first();
    if (conflict) throw new PropertyDuplicateError();
  }

  const oldValues = {
    propertyCode: existing.property_code,
    propertyType: existing.property_type,
    category: existing.category,
    status: existing.status,
    isPublic: Boolean(existing.is_public),
    ownerCustomerId: existing.owner_customer_id,
  };

  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (input.propertyCode !== undefined) set('property_code', input.propertyCode);
  if (input.propertyType !== undefined) set('property_type', input.propertyType);
  if (input.category !== undefined) set('category', input.category);
  if (input.area !== undefined) set('area', input.area);
  if (input.areaUnit !== undefined) set('area_unit', input.areaUnit);
  if (input.price !== undefined) set('price_minor_units', rupeesToMinorUnits(input.price));
  if (input.gatNoDetails !== undefined) set('gat_no_details', input.gatNoDetails);
  if (input.description !== undefined) set('description', input.description);
  if (input.address !== undefined) set('address', input.address);
  if (input.locality !== undefined) set('locality', input.locality);
  if (input.city !== undefined) set('city', input.city);
  if (input.state !== undefined) set('state', input.state);
  if (input.pincode !== undefined) set('pincode', input.pincode);
  if (input.latitude !== undefined) set('latitude', input.latitude);
  if (input.longitude !== undefined) set('longitude', input.longitude);
  if (input.mapUrl !== undefined) set('map_url', input.mapUrl);
  if (input.status !== undefined) set('status', input.status);
  if (input.isPublic !== undefined) set('is_public', input.isPublic ? 1 : 0);
  // Tri-state, same reasoning as parsePropertyBody's own doc comment:
  // `ownerCustomerIdProvided` is true both when the client explicitly
  // sent `null` (clear the owner) and when it sent a valid id (assign
  // one) — `input.ownerCustomerId` alone can't distinguish "clear" from
  // "not mentioned" the way this separate flag does.
  if (ownerCustomerIdProvided) set('owner_customer_id', ownerCustomerIdValue);
  set('updated_at', nowIso());
  set('updated_by', applicationUser.sub);

  try {
    await c.env.DB.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...params, id)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new PropertyDuplicateError();
    throw err;
  }

  const updated = await c.env.DB.prepare(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ?`)
    .bind(id)
    .first<PropertyRow>();

  // Location propagation (Phase 11/current-phase behavior, preserved
  // exactly per this phase's instructions — see
  // PropertiesService.update()'s own doc comment) — only when city/
  // state/pincode/locality actually changed, and only ever reaches
  // SELLER inquiries. Uses the *result* of the write (updated row), not
  // the raw input, so a field this request left untouched propagates its
  // already-existing value rather than an accidental NULL.
  const locationChanged =
    updated!.city !== existing.city ||
    updated!.state !== existing.state ||
    updated!.pincode !== existing.pincode ||
    updated!.locality !== existing.locality;

  if (locationChanged) {
    await c.env.DB.prepare(
      `UPDATE inquiries SET city = ?, state = ?, pincode = ?, locality = ? WHERE property_id = ? AND type = 'SELLER'`,
    )
      .bind(
        normalizeLocationValue(updated!.city),
        normalizeLocationValue(updated!.state),
        normalizeLocationValue(updated!.pincode),
        normalizeLocationValue(updated!.locality),
        id,
      )
      .run();
  }

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'PROPERTY',
    entityId: id,
    action: 'PROPERTY_UPDATED',
    oldValues,
    newValues: {
      ...input,
      ...(ownerCustomerIdProvided ? { ownerCustomerId: ownerCustomerIdValue } : {}),
    },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  // `updated` above is the plain (join-free) row, reused for the
  // location-propagation comparison; the response needs the owner's
  // display name/mobile too, so it gets its own joined re-fetch here —
  // matches the POST handler's own two-query shape (write, then a
  // separate owner-joined read for the client-facing response).
  const updatedWithOwner = await c.env.DB.prepare(`${PROPERTY_SELECT_WITH_OWNER} WHERE p.id = ?`)
    .bind(id)
    .first<PropertyRow & { owner_name: string | null; owner_mobile: string | null }>();
  return c.json(ok(toPublicPropertyWithOwnerRow(updatedWithOwner!)));
});

/**
 * DELETE /properties/:propertyId — ADMIN-only. attachments.property_id
 * is ON DELETE CASCADE in the D1 schema, same as Postgres, but a bare SQL
 * delete would silently orphan the R2 objects (the cascade only touches
 * the DB row). Matches PropertiesService.delete() exactly: every linked
 * attachment is removed first, one at a time, through the same R2-then-
 * DB-then-audit path a direct DELETE /attachments/:id uses (see
 * removeAttachmentInternal in routes/attachments.ts) — the property row
 * itself is only deleted after that loop completes.
 */
propertiesRoutes.delete('/properties/:propertyId', ...adminOnly, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('propertyId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const existing = await c.env.DB.prepare(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ?`)
    .bind(id)
    .first<PropertyRow>();
  if (!existing) throw new PropertyNotFoundError();

  const actor = {
    userId: applicationUser.sub,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };

  const attachmentIds = await c.env.DB.prepare('SELECT id FROM attachments WHERE property_id = ?')
    .bind(id)
    .all<{ id: string }>();
  for (const attachment of attachmentIds.results ?? []) {
    await removeAttachmentInternal(c.env, c.env.DB, attachment.id, actor);
  }

  await c.env.DB.prepare('DELETE FROM properties WHERE id = ?').bind(id).run();

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'PROPERTY',
    entityId: id,
    action: 'PROPERTY_DELETED',
    oldValues: { propertyCode: existing.property_code, status: existing.status },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return c.body(null, 204);
});
