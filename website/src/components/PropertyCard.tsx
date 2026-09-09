import { useState } from 'react';
import type { PublicProperty } from '../types/property';
import { formatArea, formatCategory, formatLocation, formatPrice, primaryPhoto } from '../utils/format';

interface PropertyCardProps {
  property: PublicProperty;
  onViewDetails: (id: string) => void;
}

/**
 * Every field is defensively rendered: photos=[], fileUrl=null, and
 * missing description/locality/city are all real, expected states from
 * the actual API, not edge cases to special-case away. Only public,
 * already-safe fields are shown — no internal id, no backend-only field.
 *
 * Phase 46B: reordered/restyled per the approved design (code, type ·
 * category, location, area, price, CTA) with price given the most
 * visual weight — no new fields, no invented data, every value still
 * comes straight from the API response.
 */
export default function PropertyCard({ property, onViewDetails }: PropertyCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const photo = primaryPhoto(property.photos);
  const showImage = photo?.fileUrl && !imageFailed;
  const location = formatLocation(property);
  const area = formatArea(property.area, property.areaUnit);
  const price = formatPrice(property.price, property.priceUnit);
  const category = formatCategory(property.category);

  return (
    <article className="property-card">
      <div className="property-card__image">
        {showImage ? (
          <img
            src={photo.fileUrl!}
            alt={`${property.propertyType} in ${location ?? 'Aryan Landmark listing'}`}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="property-card__image-placeholder">
            <span>No photo available</span>
          </div>
        )}
        <span className="property-card__category">{category}</span>
      </div>

      <div className="property-card__body">
        <p className="property-card__code">{property.propertyCode}</p>
        <h3 className="property-card__type">
          {property.propertyType} <span className="property-card__type-sep">&middot;</span> {category}
        </h3>
        {location && <p className="property-card__location">{location}</p>}

        <div className="property-card__facts">
          {area && (
            <p className="property-card__fact">
              <span className="property-card__fact-label">Area:</span> {area}
            </p>
          )}
          {price && <p className="property-card__price">{price}</p>}
        </div>

        {property.description && <p className="property-card__description">{property.description}</p>}

        <button type="button" className="property-card__cta" onClick={() => onViewDetails(property.id)}>
          View Details <span aria-hidden="true">→</span>
        </button>
      </div>
    </article>
  );
}
