import type { Context } from 'hono';
import { ValidationError } from './response';

/**
 * Shared pagination-query parser — Phase 8. Confirmed identical across
 * every paginated list DTO in the real backend (ListUsersQueryDto,
 * ListCustomersQueryDto, ListPropertiesQueryDto, ListInquiriesQueryDto,
 * ListNotificationsQueryDto, ListPublicPropertiesQueryDto — all reused
 * verbatim by GET /master/users too, via UsersService): `page` is
 * `@IsOptional() @Type(()=>Number) @IsInt() @Min(1)` (default 1);
 * `pageSize` is the same plus `@Max(100)` (default 20).
 *
 * Phase 7 found that GET /public/properties silently clamped invalid
 * values (Math.max/Math.min) instead of rejecting them the way NestJS's
 * ValidationPipe does. Phase 8 found the same lenient pattern copy-
 * pasted across every other paginated Worker list endpoint from Phases
 * 3-6 (users, master-users, customers, properties, inquiries,
 * notifications) — this file is the single fix point for all of them,
 * replacing each route's own inline clamp.
 *
 * Endpoints that do NOT use this: GET /attachments and the nested
 * GET /inquiries/:id/follow-ups (no page/pageSize field on their DTOs
 * at all — AttachmentListResponse/FollowUp[] have no `pagination`
 * field), and GET /follow-ups/today (deliberately unpaginated, per
 * ListTodayFollowUpsQueryDto's own doc comment) — verified by direct
 * read this phase, not assumed. Nothing was added to those files.
 */
export interface Pagination {
  page: number;
  pageSize: number;
}

function parsePositiveInt(raw: string | undefined, fieldName: string, def: number, max?: number): number {
  if (raw === undefined) return def;
  // Matches class-transformer's Type(() => Number) + class-validator's
  // @IsInt(): the transformed value must be a finite integer — NaN,
  // Infinity, decimals ("1.5"), and non-numeric strings ("abc") are all
  // rejected, exactly as @IsInt() would reject them post-transform. An
  // empty string ("?page=") transforms to Number('') === 0, which then
  // fails @Min(1) below — also correctly rejected, not treated as
  // "omitted" (only a truly absent query key uses the default above).
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`${fieldName} must be an integer.`);
  }
  if (parsed < 1) {
    throw new ValidationError(`${fieldName} must be >= 1.`);
  }
  if (max !== undefined && parsed > max) {
    throw new ValidationError(`${fieldName} must be <= ${max}.`);
  }
  return parsed;
}

/** Parses `page`/`pageSize` from the request's query string, throwing ValidationError (400) on anything the real DTO's decorators would reject. */
export function parsePagination(c: Context): Pagination {
  const page = parsePositiveInt(c.req.query('page'), 'page', 1);
  const pageSize = parsePositiveInt(c.req.query('pageSize'), 'pageSize', 20, 100);
  return { page, pageSize };
}
