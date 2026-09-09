import type { PublicPhoto, PublicProperty } from '../types/property';

/**
 * Small formatting helpers shared by PropertyCard and PropertyDetail —
 * kept here once rather than duplicated in both components.
 */

const AREA_UNIT_LABELS: Record<string, string> = {
  SQ_FT: 'sq ft',
  SQ_YD: 'sq yd',
  SQ_M: 'sq m',
  ACRE: 'acre',
  GUNTHA: 'guntha',
  HECTARE: 'hectare',
};

export function formatArea(area: number | null, areaUnit: string | null): string | null {
  if (area === null) return null;
  const unitLabel = areaUnit ? (AREA_UNIT_LABELS[areaUnit] ?? areaUnit) : '';
  return unitLabel ? `${area} ${unitLabel}` : String(area);
}

export function formatPrice(price: number | null, priceUnit: string | null): string | null {
  if (price === null) return null;
  // priceUnit is always "INR" in practice today (see backend's own
  // documented note) — formatted with Indian digit grouping either way.
  const formatted = new Intl.NumberFormat('en-IN').format(price);
  return priceUnit === 'INR' || !priceUnit ? `₹${formatted}` : `${formatted} ${priceUnit}`;
}

export function formatLocation(property: Pick<PublicProperty, 'locality' | 'city'>): string | null {
  const parts = [property.locality, property.city].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

export function primaryPhoto(photos: PublicPhoto[]): PublicPhoto | null {
  if (photos.length === 0) return null;
  return photos.find((photo) => photo.isPrimary) ?? photos[0];
}

/** Display-cased category label ('RESIDENTIAL' -> 'Residential') — purely cosmetic, the raw enum value is never sent anywhere. */
export function formatCategory(category: string): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}
