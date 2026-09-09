/**
 * Mirrors the backend's actual public API response shape exactly
 * (see D:\aryan-landmark\backend\src\worker\routes\public-properties.ts
 * and docs/api/openapi.yaml's PublicProperty/PublicPhoto/Pagination
 * schemas). Nothing here is invented — every field either comes from
 * toPublicPropertySummary()'s explicit allow-list or toPublicPropertyPhoto().
 * Deliberately does NOT include ownerCustomerId/owner/r2ObjectKey/r2Bucket
 * — those are not returned by the public API at all.
 */

export type PropertyCategory = 'RESIDENTIAL' | 'INDUSTRIAL' | 'COMMERCIAL' | 'AGRICULTURAL';

export type PropertyAreaUnit = 'SQ_FT' | 'SQ_YD' | 'SQ_M' | 'ACRE' | 'GUNTHA' | 'HECTARE';

export type PropertyStatus = 'AVAILABLE' | 'SOLD' | 'ON_HOLD' | 'INACTIVE';

/**
 * A PHOTO attachment as exposed to public visitors. `fileUrl` is a
 * short-lived signed R2 GET URL minted fresh per API request — never a
 * stable/cacheable link, and `null` when it could not be minted (e.g.
 * R2 temporarily unreachable), never an error.
 */
export interface PublicPhoto {
  id: string;
  fileUrl: string | null;
  isPrimary: boolean;
  displayOrder: number;
}

export interface PublicProperty {
  id: string;
  propertyCode: string;
  propertyType: string;
  category: PropertyCategory;
  area: number | null;
  areaUnit: PropertyAreaUnit | null;
  price: number | null;
  priceUnit: string | null;
  description: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  status: PropertyStatus;
  photos: PublicPhoto[];
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
