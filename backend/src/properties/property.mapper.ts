import { PropertyCategoryValue, PropertyStatusValue } from '../common/types/domain-enums';

/**
 * Matches components.schemas.Property in docs/api/openapi.yaml exactly —
 * no createdBy/updatedBy/audit fields, since the documented Property
 * response doesn't include them.
 */
export interface PublicProperty {
  id: string;
  propertyCode: string;
  propertyType: string;
  category: PropertyCategoryValue;
  area: number | null;
  areaUnit: string | null;
  price: number | null;
  priceUnit: string | null;
  gatNoDetails: string | null;
  description: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  status: PropertyStatusValue;
}

interface PropertyRow {
  id: string;
  propertyCode: string;
  propertyType: string;
  category: string;
  area: unknown;
  areaUnit: string | null;
  price: unknown;
  priceUnit: string | null;
  gatNoDetails: string | null;
  description: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: unknown;
  longitude: unknown;
  mapUrl: string | null;
  status: string;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // Prisma Decimal fields come back as Decimal.js-like objects at
  // runtime, not plain numbers; Number(...) handles both that and plain
  // numbers/strings uniformly.
  return Number(value);
}

export function toPublicProperty(row: PropertyRow): PublicProperty {
  return {
    id: row.id,
    propertyCode: row.propertyCode,
    propertyType: row.propertyType,
    category: row.category as PropertyCategoryValue,
    area: toNullableNumber(row.area),
    areaUnit: row.areaUnit,
    price: toNullableNumber(row.price),
    priceUnit: row.priceUnit,
    gatNoDetails: row.gatNoDetails,
    description: row.description,
    address: row.address,
    locality: row.locality,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
    mapUrl: row.mapUrl,
    status: row.status as PropertyStatusValue,
  };
}
