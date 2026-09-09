import { useEffect, useState, type FormEvent } from 'react';
import { getProperties } from '../api/properties';
import { ApiError } from '../api/client';
import type { Pagination, PropertyCategory, PublicProperty } from '../types/property';
import PropertyCard from './PropertyCard';
import PropertyDetail from './PropertyDetail';

const PAGE_SIZE = 12;

// The API's own controlled vocabulary (see types/property.ts's
// PropertyCategory, mirroring the backend's CHECK constraint) — not an
// invented list. City has no such fixed set, so it stays a free-text
// filter rather than a dropdown.
const CATEGORY_OPTIONS: { value: PropertyCategory; label: string }[] = [
  { value: 'RESIDENTIAL', label: 'Residential' },
  { value: 'COMMERCIAL', label: 'Commercial' },
  { value: 'INDUSTRIAL', label: 'Industrial' },
  { value: 'AGRICULTURAL', label: 'Agricultural' },
];

/**
 * Phase 46B: filter markup restyled from a bordered admin-style form
 * into category pill buttons + a search-style city field — same
 * underlying state and handlers as before (category applies
 * immediately, city applies on submit), no API/behavior change.
 */
export default function PropertyList() {
  const [properties, setProperties] = useState<PublicProperty[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  // Applied filters (drive the API call) vs. the city draft field — kept
  // separate so typing a city doesn't fire a request per keystroke; the
  // city filter only takes effect on form submit. Category applies
  // immediately on click (no keystroke-storm risk).
  const [category, setCategory] = useState('');
  const [city, setCity] = useState('');
  const [cityDraft, setCityDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getProperties({
      page,
      pageSize: PAGE_SIZE,
      category: category || undefined,
      city: city || undefined,
    })
      .then((result) => {
        if (cancelled) return;
        setProperties(result.properties);
        setPagination(result.pagination);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : 'Could not load properties right now. Please try again.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, category, city]);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCity(cityDraft.trim());
    setPage(1);
  }

  function handleCategoryChange(value: string) {
    setCategory(value);
    setPage(1);
  }

  function handleClearFilters() {
    setCategory('');
    setCity('');
    setCityDraft('');
    setPage(1);
  }

  const hasActiveFilters = category !== '' || city !== '';

  return (
    <section id="properties" className="property-list" aria-label="Available properties">
      <div className="section-heading">
        <h2>Available Properties</h2>
        <p>Explore properties currently available through Aryan Landmark.</p>
      </div>

      <div className="property-search">
        <div className="property-search__categories" role="group" aria-label="Filter by category">
          <button
            type="button"
            className={category === '' ? 'pill pill--active' : 'pill'}
            aria-pressed={category === ''}
            onClick={() => handleCategoryChange('')}
          >
            All
          </button>
          {CATEGORY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={category === option.value ? 'pill pill--active' : 'pill'}
              aria-pressed={category === option.value}
              onClick={() => handleCategoryChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <form className="property-search__city" onSubmit={handleFilterSubmit} role="search">
          <label htmlFor="filter-city" className="sr-only">
            Search by city
          </label>
          <div className="property-search__city-field">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              id="filter-city"
              type="text"
              value={cityDraft}
              onChange={(event) => setCityDraft(event.target.value)}
              placeholder="Search by city, e.g. Pune"
            />
          </div>
          <div className="property-search__actions">
            <button type="submit" className="button button--primary">
              Search
            </button>
            {hasActiveFilters && (
              <button type="button" className="button button--ghost" onClick={handleClearFilters}>
                Clear filters
              </button>
            )}
          </div>
        </form>
      </div>

      {loading && (
        <p className="state-message" role="status">
          Loading properties…
        </p>
      )}

      {!loading && error && (
        <p className="state-message state-message--error" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && properties.length === 0 && (
        <div className="state-message--empty">
          <p className="state-message">
            {hasActiveFilters
              ? 'No properties match these filters. Try a different search.'
              : 'No properties are currently listed. Please check back soon.'}
          </p>
        </div>
      )}

      {!loading && !error && properties.length > 0 && (
        <>
          <div className="property-grid">
            {properties.map((property) => (
              <PropertyCard key={property.id} property={property} onViewDetails={setSelectedPropertyId} />
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <nav className="pagination" aria-label="Property list pages">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={pagination.page <= 1}
              >
                Previous
              </button>
              <span>
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}

      {selectedPropertyId && (
        <PropertyDetail propertyId={selectedPropertyId} onClose={() => setSelectedPropertyId(null)} />
      )}
    </section>
  );
}
