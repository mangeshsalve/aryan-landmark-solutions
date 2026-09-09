import { apiGet, apiGetPaginated } from './client';
import type { Pagination, PublicProperty } from '../types/property';

/**
 * Typed wrappers around the two public backend endpoints
 * (GET /public/properties, GET /public/properties/:id). Components must
 * call these, never construct a URL or call fetch()/apiGet* directly —
 * keeps the query-parameter shape and endpoint paths in exactly one
 * place.
 */

export interface GetPropertiesParams {
  page?: number;
  pageSize?: number;
  category?: string;
  city?: string;
}

export interface GetPropertiesResult {
  properties: PublicProperty[];
  pagination: Pagination;
}

export async function getProperties(params: GetPropertiesParams = {}): Promise<GetPropertiesResult> {
  const { data, pagination } = await apiGetPaginated<PublicProperty[]>('public/properties', {
    page: params.page,
    pageSize: params.pageSize,
    category: params.category,
    city: params.city,
  });
  return { properties: data, pagination };
}

export async function getPropertyById(id: string): Promise<PublicProperty> {
  return apiGet<PublicProperty>(`public/properties/${encodeURIComponent(id)}`);
}
