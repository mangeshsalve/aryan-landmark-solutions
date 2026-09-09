import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Bindings } from '../types/bindings';
import { ok, okPaginated, PropertyNotFoundError, ValidationError } from '../utils/response';
import { parsePagination } from '../utils/pagination';
import { isValidUuid } from '../utils/id';
import { minorUnitsToRupees } from '../utils/money';
import { PROPERTY_COLUMNS, PropertyRow } from './properties';
import { AttachmentRow } from './attachments';
import { createDownloadAuthorization, isR2Configured } from '../utils/r2';

/**
 * /api/v1/public/properties — unauthenticated, public-facing property
 * data. Originally ported field-for-field from
 * PublicPropertiesController/PropertiesService.listPublic() (list-only).
 *
 * Phase 42B adds a detail route and fixes a real leak the list route
 * already had: the list route used to reuse routes/properties.ts's
 * *internal* toPublicProperty()/PROPERTY_COLUMNS mapper, which includes
 * ownerCustomerId (and, when joined, a nested owner{name,mobile}) — an
 * internal customer identifier with no legitimate public purpose. Both
 * public routes below now go through toPublicPropertySummary(), a
 * dedicated, from-scratch allow-list mapper defined only in this file —
 * it has no access to owner data at all (the query it's built from never
 * joins `users`), so there is no code path by which owner information
 * could reach a public response, by construction, not by remembering to
 * omit a field.
 *
 * Photo URLs: the R2 bucket stays private (no CLOUDFLARE_R2_PUBLIC_BASE_URL,
 * no bucket/object-key exposure) — every photo URL returned here is a
 * short-lived signed GET URL, minted via the exact same
 * createDownloadAuthorization() the staff-only
 * GET /attachments/:id/download-url route already uses internally. The
 * safety property is entirely in *which* rows are ever handed to that
 * function: only PHOTO attachments whose parent property already passed
 * the is_public=1 AND status='AVAILABLE' gate (the query in both routes
 * below joins/filters on exactly that, server-side, before any signing
 * happens) — a DOCUMENT, a RECORDING, or a photo belonging to a non-public
 * or non-AVAILABLE property can never reach createDownloadAuthorization()
 * from either route in this file.
 */

const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'];

/**
 * Dedicated public-property mapper — deliberately NOT a call to
 * routes/properties.ts's toPublicProperty() (the internal mapper), and
 * deliberately an explicit allow-list rather than a deny-list, per this
 * project's established convention (see e.g. attachment.mapper.ts's own
 * reasoning). ownerCustomerId/owner/gatNoDetails/isPublic are not merely
 * omitted here — they are never read from `row` at all, so there is
 * nothing to accidentally forward if PropertyRow ever grows a new
 * internal field.
 */
function toPublicPropertySummary(row: PropertyRow) {
  return {
    id: row.id,
    propertyCode: row.property_code,
    propertyType: row.property_type,
    category: row.category,
    area: row.area,
    areaUnit: row.area_unit,
    price: minorUnitsToRupees(row.price_minor_units),
    priceUnit: row.price_unit,
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
  };
}

/**
 * A PHOTO attachment as exposed to public visitors. Only `id`,
 * `r2_object_key` (used server-side only, to sign — never returned),
 * `is_primary`, `display_order` are selected by either caller below; no
 * r2_bucket, no uploaded_by, no file_name/mime_type/file_size_bytes.
 */
type PhotoRow = Pick<AttachmentRow, 'id' | 'property_id' | 'r2_object_key' | 'is_primary' | 'display_order'>;

/**
 * Mints a short-lived signed GET URL for one PHOTO row, using the exact
 * same signing primitive (utils/r2.ts's createDownloadAuthorization,
 * same DOWNLOAD_URL_EXPIRES_IN_SECONDS as the staff-only download-url
 * route) already proven in production — no new expiry, no new signing
 * logic. Field name (`fileUrl`) kept identical to the pre-existing
 * public response shape for backward compatibility; only what it's
 * populated with has changed (a real, working, short-lived URL instead
 * of the always-null value the old file_url-column approach produced
 * without CLOUDFLARE_R2_PUBLIC_BASE_URL configured).
 *
 * Never throws: if R2 isn't configured, or signing unexpectedly fails,
 * this degrades to fileUrl: null for that one photo rather than failing
 * the entire public property response — a public visitor should still
 * see the property's other fields/photos even if one image URL
 * couldn't be minted.
 */
async function toPublicPropertyPhoto(env: Bindings, row: PhotoRow) {
  let fileUrl: string | null = null;
  if (isR2Configured(env)) {
    try {
      const auth = await createDownloadAuthorization(env, row.r2_object_key);
      fileUrl = auth.downloadUrl;
    } catch {
      fileUrl = null;
    }
  }
  return {
    id: row.id,
    fileUrl,
    isPrimary: Boolean(row.is_primary),
    displayOrder: row.display_order,
  };
}

export const publicPropertiesRoutes = new Hono<AppEnv>();

// Phase 42B — CORS scoped to this router's own concrete paths, NOT a
// bare '*' pattern. index.ts mounts every route module at the same root
// ('/', via api.route('/', xRoutes)) — there is no sub-path prefix
// boundary between routers once merged into the shared `api` Hono
// instance, so a `.use('*', cors(...))` here would actually match every
// route in the whole app (verified empirically: it leaked
// Access-Control-Allow-Origin onto the authenticated GET /properties
// route during local testing before this fix). Registering the
// middleware against the exact two path patterns this router serves
// keeps it correctly scoped regardless of how routers are mounted. No
// credentials (cookies/Authorization) are ever read by these routes, so
// origin: '*' with no Access-Control-Allow-Credentials is the correct,
// safe shape for a public, unauthenticated, read-only API.
//
// Phase 45B fix: this was previously registered on '/public/properties/*'
// (a multi-segment wildcard). That also matched the new
// POST /public/properties/:propertyId/inquiries route
// (routes/public-inquiries.ts) — a different resource that happens to
// share this URL prefix — and, since this router is mounted before that
// one in index.ts, it won this router's GET-only CORS middleware for
// that route's OPTIONS preflight too, incorrectly advertising
// Access-Control-Allow-Methods: GET instead of POST (verified locally:
// this would have silently blocked every real cross-origin browser
// submission, even though a direct POST without a preflight still
// "worked"). '/public/properties/:id' matches exactly one path segment
// after the prefix — this router's own GET /public/properties/:id route
// shape — so it no longer reaches into a sibling router's path space.
const publicCors = cors({ origin: '*', allowMethods: ['GET'] });
publicPropertiesRoutes.use('/public/properties', publicCors);
publicPropertiesRoutes.use('/public/properties/:id', publicCors);

publicPropertiesRoutes.get('/public/properties', async (c) => {
  // Matches ListPublicPropertiesQueryDto's @Type(()=>Number) @IsInt()
  // @Min(1) (page) / @Max(100) (pageSize) exactly — see utils/pagination.ts
  // (Phase 8: this endpoint's own Phase 7 inline fix was consolidated
  // into that shared utility, now reused by every paginated list route).
  const { page, pageSize } = parsePagination(c);

  const category = c.req.query('category');
  const city = c.req.query('city');

  if (category && !PROPERTY_CATEGORIES.includes(category)) {
    throw new ValidationError(`category must be one of ${PROPERTY_CATEGORIES.join(', ')}.`);
  }
  if (city && city.length > 100) {
    throw new ValidationError('city must be a string, max 100 characters.');
  }

  // Visibility gate — matches PropertiesService.listPublic() exactly:
  // isPublic alone is NOT sufficient, status must also be AVAILABLE
  // (verified against properties.service.spec.ts's explicit test for
  // this exact requirement).
  const conditions = ['is_public = 1', "status = 'AVAILABLE'"];
  const params: unknown[] = [];
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (city) {
    // Case-insensitive EXACT match, not contains — matches Prisma's
    // `{ equals: query.city, mode: 'insensitive' }` exactly, not the
    // internal /properties endpoint's own case-insensitive-equals (same
    // rule, confirmed independently here since this is a separate query
    // path with its own where-clause, not shared code).
    conditions.push('LOWER(city) = LOWER(?)');
    params.push(city);
  }
  const where = conditions.join(' AND ');

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM properties WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = totalRow?.count ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<PropertyRow>();

  const properties = rows.results ?? [];
  const propertyIds = properties.map((row) => row.id);

  // Single batched query for all photos across the whole page — matches
  // listPublic()'s own "one query regardless of page size" approach
  // (attachment.findMany({ propertyId: { in: propertyIds } })), not a
  // per-property N+1 D1 lookup. Signing each photo's URL is a local
  // HMAC computation (createDownloadAuthorization never makes a network
  // call — see utils/r2.ts), so awaiting one per photo here is cheap.
  const photosByProperty = new Map<string, Awaited<ReturnType<typeof toPublicPropertyPhoto>>[]>();
  if (propertyIds.length > 0) {
    const placeholders = propertyIds.map(() => '?').join(', ');
    const photoRows = await c.env.DB.prepare(
      `SELECT id, property_id, r2_object_key, is_primary, display_order
       FROM attachments
       WHERE property_id IN (${placeholders}) AND attachment_type = 'PHOTO'
       ORDER BY display_order ASC, created_at DESC`,
    )
      .bind(...propertyIds)
      .all<PhotoRow>();

    const signedPhotos = await Promise.all(
      (photoRows.results ?? []).map((photo) => toPublicPropertyPhoto(c.env, photo)),
    );
    (photoRows.results ?? []).forEach((photo, index) => {
      if (!photo.property_id) return;
      const bucket = photosByProperty.get(photo.property_id) ?? [];
      bucket.push(signedPhotos[index]);
      photosByProperty.set(photo.property_id, bucket);
    });
  }

  const data = properties.map((row) => ({
    ...toPublicPropertySummary(row),
    photos: photosByProperty.get(row.id) ?? [],
  }));

  // Phase 42B — short, safe cache window for non-personalized, public,
  // unauthenticated GET data. No per-visitor state, no cookies, nothing
  // sensitive; 60s is short enough that a just-unpublished property
  // doesn't stay visible for long, long enough to meaningfully reduce
  // repeat-visitor load on a one-page site polling this on load.
  c.header('Cache-Control', 'public, max-age=60');

  return c.json(okPaginated(data, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }));
});

/**
 * Phase 42B — GET /public/properties/:id. Same visibility gate as the
 * list route, applied directly in the WHERE clause (not "fetch then
 * check in JS") so a property that exists but isn't public/available
 * resolves to the exact same PropertyNotFoundError as a genuinely
 * nonexistent id — never leaking *which* case it was, matching this
 * project's established "don't leak why" principle (see e.g.
 * InvalidCredentialsError, AuthTokenInvalidError elsewhere in this
 * codebase).
 */
publicPropertiesRoutes.get('/public/properties/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const row = await c.env.DB.prepare(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ? AND is_public = 1 AND status = 'AVAILABLE'`,
  )
    .bind(id)
    .first<PropertyRow>();
  if (!row) throw new PropertyNotFoundError();

  const photoRows = await c.env.DB.prepare(
    `SELECT id, property_id, r2_object_key, is_primary, display_order
     FROM attachments
     WHERE property_id = ? AND attachment_type = 'PHOTO'
     ORDER BY display_order ASC, created_at DESC`,
  )
    .bind(id)
    .all<PhotoRow>();

  const photos = await Promise.all(
    (photoRows.results ?? []).map((photo) => toPublicPropertyPhoto(c.env, photo)),
  );

  c.header('Cache-Control', 'public, max-age=60');

  return c.json(ok({ ...toPublicPropertySummary(row), photos }));
});
