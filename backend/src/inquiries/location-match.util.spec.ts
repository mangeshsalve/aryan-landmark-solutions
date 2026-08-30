import {
  deriveSyncedLocationFromProperty,
  normalizeLocationValue,
  scoreLocationQuality,
} from './location-match.util';

describe('normalizeLocationValue', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeLocationValue('  Pune  ')).toBe('Pune');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeLocationValue('Pune   City')).toBe('Pune City');
  });

  it('converts an empty-after-trim string to null', () => {
    expect(normalizeLocationValue('   ')).toBeNull();
    expect(normalizeLocationValue('')).toBeNull();
  });

  it('passes null/undefined through as null', () => {
    expect(normalizeLocationValue(null)).toBeNull();
    expect(normalizeLocationValue(undefined)).toBeNull();
  });

  it('leaves an already-clean value untouched', () => {
    expect(normalizeLocationValue('Pune')).toBe('Pune');
  });
});

describe('scoreLocationQuality — city (normalized, not raw equality)', () => {
  it('scores 50 for an exact match', () => {
    expect(
      scoreLocationQuality({ city: 'Pune', locality: null }, { city: 'Pune', locality: null }),
    ).toBe(50);
  });

  it('is case-insensitive', () => {
    expect(
      scoreLocationQuality({ city: 'PUNE', locality: null }, { city: 'pune', locality: null }),
    ).toBe(50);
  });

  it('ignores punctuation differences', () => {
    expect(
      scoreLocationQuality({ city: 'Pune,', locality: null }, { city: 'Pune', locality: null }),
    ).toBe(50);
  });

  it('does NOT trim/normalize away a genuinely different city', () => {
    expect(
      scoreLocationQuality({ city: 'Pune', locality: null }, { city: 'Mumbai', locality: null }),
    ).toBe(0);
  });

  it('scores 0 when either side has no city and no locality overlap', () => {
    expect(
      scoreLocationQuality({ city: null, locality: null }, { city: 'Pune', locality: null }),
    ).toBe(0);
    expect(
      scoreLocationQuality({ city: 'Pune', locality: null }, { city: null, locality: null }),
    ).toBe(0);
  });
});

describe('scoreLocationQuality — locality (token-based fuzzy)', () => {
  it('matches your worked example: different full addresses sharing one meaningful locality token', () => {
    const source = { city: null, locality: 'Hanuman Colony, Alandi Road, Bhosari, Pune, 411039' };
    const candidate = { city: null, locality: 'Dhawade Wasti, Nashik Highway, Bhosari, 411039' };

    expect(scoreLocationQuality(source, candidate)).toBe(50);
  });

  it('does NOT match on generic/stopword-only overlap (road/colony/highway alone)', () => {
    const source = { city: null, locality: 'Some Road, Some Colony' };
    const candidate = { city: null, locality: 'Other Road, Other Highway' };

    expect(scoreLocationQuality(source, candidate)).toBe(0);
  });

  it('ignores numeric tokens (e.g. a pincode embedded in free text) as a matching signal', () => {
    const source = { city: null, locality: 'Flat 12, 411039' };
    const candidate = { city: null, locality: 'Flat 45, 411039' };

    // Only shared token is the pincode digit-string "411039" — filtered
    // out as purely numeric, so this must NOT count as a locality match.
    expect(scoreLocationQuality(source, candidate)).toBe(0);
  });

  it('ignores very short tokens (<=2 chars)', () => {
    const source = { city: null, locality: 'A B Bhosari' };
    const candidate = { city: null, locality: 'X Y Nagpur' };

    expect(scoreLocationQuality(source, candidate)).toBe(0);
  });

  it('is case/punctuation-insensitive, same as city', () => {
    const source = { city: null, locality: 'BHOSARI-East' };
    const candidate = { city: null, locality: 'bhosari east area' };

    expect(scoreLocationQuality(source, candidate)).toBe(50);
  });

  it('returns 0 when locality is null/empty on either side and city also does not match', () => {
    expect(
      scoreLocationQuality({ city: null, locality: null }, { city: null, locality: 'Bhosari' }),
    ).toBe(0);
    expect(
      scoreLocationQuality({ city: null, locality: 'Bhosari' }, { city: null, locality: null }),
    ).toBe(0);
  });
});

describe('scoreLocationQuality — MAX(city, locality), not summed', () => {
  it('caps at 50 even when both city and locality match', () => {
    const source = { city: 'Pune', locality: 'Bhosari' };
    const candidate = { city: 'Pune', locality: 'Bhosari' };

    expect(scoreLocationQuality(source, candidate)).toBe(50);
  });

  it('a locality-only match is worth exactly as much as a city-only match', () => {
    const cityOnly = scoreLocationQuality(
      { city: 'Pune', locality: null },
      { city: 'Pune', locality: null },
    );
    const localityOnly = scoreLocationQuality(
      { city: 'CityA', locality: 'Bhosari' },
      { city: 'CityB', locality: 'Bhosari, somewhere else' },
    );

    expect(cityOnly).toBe(50);
    expect(localityOnly).toBe(50);
  });
});

describe('deriveSyncedLocationFromProperty', () => {
  it('copies city/state/pincode/locality straight from the property, normalized', () => {
    const result = deriveSyncedLocationFromProperty({
      city: '  Pune  ',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
    });

    expect(result).toEqual({
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
    });
  });

  it('leaves locality null when the property has no locality set (never falls back to address)', () => {
    const result = deriveSyncedLocationFromProperty({
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: null,
    });

    expect(result.locality).toBeNull();
  });

  it('passes through nulls for every field when the property has none set', () => {
    const result = deriveSyncedLocationFromProperty({
      city: null,
      state: null,
      pincode: null,
      locality: null,
    });

    expect(result).toEqual({ city: null, state: null, pincode: null, locality: null });
  });
});
