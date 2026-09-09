import { useEffect, useRef, useState } from 'react';
import { getPropertyById } from '../api/properties';
import { ApiError } from '../api/client';
import type { PublicProperty } from '../types/property';
import { formatArea, formatCategory, formatLocation, formatPrice } from '../utils/format';
import PropertyInquiryForm from './PropertyInquiryForm';

interface PropertyDetailProps {
  propertyId: string;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * In-page modal (Phase 43A's approved approach — no route, no
 * react-router, no third-party dialog/gallery library: a single
 * hand-written focus trap + Escape-to-close + simple main/thumbnail
 * gallery is small enough to not justify a new dependency).
 *
 * Phase 46B: content reordered per the approved design (image, code,
 * type/category, price, location, facts, description, address, CTA) —
 * every accessibility behavior below (focus trap, Escape, body-scroll
 * lock, focus restoration via the nested inquiry form, dialog roles) is
 * unchanged from Phase 43C/45C, only the visual layout moved.
 */
export default function PropertyDetail({ propertyId, onClose }: PropertyDetailProps) {
  const [property, setProperty] = useState<PublicProperty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const [mainImageFailed, setMainImageFailed] = useState(false);
  const [inquiryFormOpen, setInquiryFormOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProperty(null);
    setActivePhotoIndex(0);
    setMainImageFailed(false);

    getPropertyById(propertyId)
      .then((result) => {
        if (!cancelled) setProperty(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load this property. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  useEffect(() => {
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The nested "I'm Interested" form (PropertyInquiryForm) is its
        // own modal with its own Escape handler — both listen on
        // `document`, so without this guard Escape would close both at
        // once. Let the topmost (inquiry form) modal handle it alone.
        if (inquiryFormOpen) return;
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      // Minimal focus trap: keep Tab/Shift+Tab cycling within the dialog.
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    // Prevent the page behind the modal from scrolling on mobile/desktop.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, inquiryFormOpen]);

  const location = property ? formatLocation(property) : null;
  const area = property ? formatArea(property.area, property.areaUnit) : null;
  const price = property ? formatPrice(property.price, property.priceUnit) : null;
  const category = property ? formatCategory(property.category) : null;

  // Only photos with a working signed URL are navigable — a null/failed
  // fileUrl never becomes a gallery entry a visitor could select and see
  // nothing.
  const galleryPhotos = property?.photos.filter((photo) => photo.fileUrl) ?? [];
  const activePhoto = galleryPhotos[activePhotoIndex] ?? null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="property-detail-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close property details">
          &times;
        </button>

        {loading && (
          <p className="state-message" role="status">
            Loading property details…
          </p>
        )}

        {error && (
          <p className="state-message state-message--error" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && property && (
          <div>
            {activePhoto && !mainImageFailed ? (
              <div className="modal-gallery">
                <div className="modal-gallery__main-wrap">
                  <img
                    className="modal-gallery__main"
                    src={activePhoto.fileUrl!}
                    alt={`${property.propertyType} — photo ${activePhotoIndex + 1} of ${galleryPhotos.length}`}
                    onError={() => setMainImageFailed(true)}
                  />
                  <span className="modal-category">{category}</span>
                </div>
                {galleryPhotos.length > 1 && (
                  <div className="modal-gallery__thumbs" role="list">
                    {galleryPhotos.map((photo, index) => (
                      <button
                        key={photo.id}
                        type="button"
                        role="listitem"
                        className={
                          index === activePhotoIndex
                            ? 'modal-gallery__thumb modal-gallery__thumb--active'
                            : 'modal-gallery__thumb'
                        }
                        aria-label={`Show photo ${index + 1} of ${galleryPhotos.length}`}
                        aria-current={index === activePhotoIndex}
                        onClick={() => {
                          setActivePhotoIndex(index);
                          setMainImageFailed(false);
                        }}
                      >
                        <img src={photo.fileUrl!} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="property-card__image-placeholder property-card__image-placeholder--modal">
                <span>No photo available</span>
              </div>
            )}

            <p className="property-card__code">{property.propertyCode}</p>
            <h2 id="property-detail-title" className="property-modal__title">
              {property.propertyType} <span className="property-card__type-sep">&middot;</span> {category}
            </h2>
            {price && <p className="property-modal__price">{price}</p>}
            {location && <p className="property-card__location">{location}</p>}

            {area && (
              <dl className="property-card__facts">
                <div>
                  <dt>Area</dt>
                  <dd>{area}</dd>
                </div>
              </dl>
            )}

            {property.description && <p className="modal-description">{property.description}</p>}

            {(property.address || property.locality || property.city || property.state || property.pincode) && (
              <p className="modal-address">
                {[property.address, property.locality, property.city, property.state, property.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            )}

            {property.mapUrl && (
              <a className="modal-map-link" href={property.mapUrl} target="_blank" rel="noreferrer">
                View on map
              </a>
            )}

            <button
              type="button"
              className="button button--primary modal-cta"
              onClick={() => setInquiryFormOpen(true)}
            >
              I&rsquo;m Interested
            </button>
          </div>
        )}
      </div>

      {inquiryFormOpen && property && (
        <PropertyInquiryForm
          propertyId={property.id}
          propertyCode={property.propertyCode}
          propertyType={property.propertyType}
          category={category ?? property.category}
          location={location}
          onClose={() => setInquiryFormOpen(false)}
        />
      )}
    </div>
  );
}
