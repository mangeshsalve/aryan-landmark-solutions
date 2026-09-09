/**
 * Ported verbatim from src/inquiries/location-match.util.ts — the single
 * source of location normalization + fuzzy-matching logic shared by both
 * inquiries.ts (matching, create/update sync) and properties.ts
 * (propagation to linked SELLER inquiries on property edit). Phase 4's
 * properties.ts had its own inline copy of normalizeLocationValue; that
 * copy is removed in this phase in favor of importing from here, per this
 * phase's explicit "do not create duplicate normalization implementations"
 * instruction — there is now exactly one normalizeLocationValue in the
 * Worker, matching the real backend having exactly one.
 *
 * Matching algorithm (unchanged from the real backend, reproduced exactly
 * — see the original file for the full rationale):
 *  - pincode (30 pts): mandatory gate, exact match after normalization.
 *  - location quality (up to 50) = MAX(cityScore, localityScore):
 *      - city (50): normalized exact compare.
 *      - locality (50): token-overlap fuzzy match, stopwords/short/numeric
 *        tokens filtered out.
 *  - budget (20 pts): unchanged, asymmetric (see routes/inquiries.ts).
 *  - Threshold: 70/100. Achievable totals: 30/50/80/100 — the effective
 *    minimum passing score is therefore 80, a mathematical consequence of
 *    the weights, not a separate rule (see the original file).
 */

const LOCATION_STOPWORDS = new Set([
  'road',
  'rd',
  'street',
  'st',
  'marg',
  'lane',
  'ln',
  'colony',
  'society',
  'soc',
  'apartment',
  'apartments',
  'apt',
  'complex',
  'chowk',
  'wasti',
  'wadi',
  'peth',
  'highway',
  'hwy',
  'nagar',
  'phase',
  'sector',
  'plot',
  'near',
  'opp',
  'opposite',
  'behind',
  'above',
  'floor',
  'flat',
  'building',
  'bldg',
  'wing',
  'tower',
  'chs',
  'village',
  'gaothan',
  'taluka',
  'tehsil',
  'district',
  'dist',
  'state',
  'pin',
  'pincode',
  'india',
  'the',
  'and',
  'of',
  'at',
  'in',
  'on',
]);

/** Write-time normalization — trim + collapse whitespace; empty-after-trim becomes null. */
export function normalizeLocationValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

/** Match-time normalization for city comparison — lowercase + punctuation stripped to a space. */
function normalizeForCompare(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Tokenizes a locality string: normalize, split, drop tokens <=2 chars, purely numeric, or a stopword. */
function tokenize(value: string | null): Set<string> {
  const normalized = normalizeForCompare(value);
  if (!normalized) return new Set();
  return new Set(
    normalized
      .split(' ')
      .filter(
        (token) => token.length > 2 && !/^\d+$/.test(token) && !LOCATION_STOPWORDS.has(token),
      ),
  );
}

function hasSharedToken(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

/** Location-quality score (up to 50) — MAX, not SUM, of city-exact and locality-fuzzy. */
export function scoreLocationQuality(
  source: { city: string | null; locality: string | null },
  candidate: { city: string | null; locality: string | null },
): number {
  const sourceCityNorm = normalizeForCompare(source.city);
  const candidateCityNorm = normalizeForCompare(candidate.city);
  const cityScore = sourceCityNorm !== null && sourceCityNorm === candidateCityNorm ? 50 : 0;

  const localityScore = hasSharedToken(tokenize(source.locality), tokenize(candidate.locality))
    ? 50
    : 0;

  return Math.max(cityScore, localityScore);
}

// --- Phase 40B — percentage-based per-dimension scoring for the
// redesigned matching engine (routes/inquiries.ts's GET
// /inquiries/:inquiryId/matches). Deliberately additive: scoreLocationQuality
// above is left completely unchanged (its old MAX-of-city-or-locality,
// 0-50-point shape belonged to the old fixed-point matchingScore
// formula) — these new functions reuse the exact same internal
// normalizeForCompare/tokenize/hasSharedToken helpers, just each scored
// independently as its own 0-100 percentage rather than combined via
// MAX, and returning `null` (not 0) when either side has no usable
// value, so a missing field can be excluded from the overall weighted
// average rather than counted as a hard failure. ---

/** Shared exact-normalized-match percentage: 100 on match, 0 on mismatch, null if either side is missing/empty. Used for pincode/city/state — all three are exact-match dimensions with identical semantics, just different source fields. */
function scoreExactNormalizedMatch(source: string | null, candidate: string | null): number | null {
  const sourceNorm = normalizeForCompare(source);
  const candidateNorm = normalizeForCompare(candidate);
  if (sourceNorm === null || candidateNorm === null) return null;
  return sourceNorm === candidateNorm ? 100 : 0;
}

/** PIN code percentage — exact match after normalization. */
export function scorePincodeMatch(source: string | null, candidate: string | null): number | null {
  return scoreExactNormalizedMatch(source, candidate);
}

/** City percentage — exact match after normalization. */
export function scoreCityMatch(source: string | null, candidate: string | null): number | null {
  return scoreExactNormalizedMatch(source, candidate);
}

/** State percentage — exact match after normalization. */
export function scoreStateMatch(source: string | null, candidate: string | null): number | null {
  return scoreExactNormalizedMatch(source, candidate);
}

/** Locality percentage — reuses the exact same tokenize/hasSharedToken fuzzy token-overlap logic scoreLocationQuality already uses internally, just returned as its own independent 0-100 value (never combined with city) and null (not 0) when either side has no usable tokens at all, so it can be excluded from the overall weighted average rather than treated as a failed match. */
export function scoreLocalityMatch(source: string | null, candidate: string | null): number | null {
  const sourceTokens = tokenize(source);
  const candidateTokens = tokenize(candidate);
  if (sourceTokens.size === 0 || candidateTokens.size === 0) return null;
  return hasSharedToken(sourceTokens, candidateTokens) ? 100 : 0;
}

export interface PropertyLocationSnapshot {
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
}

/** The single Property→Inquiry sync rule: locality from Property.locality only, never Property.address. */
export function deriveSyncedLocationFromProperty(property: {
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
}): PropertyLocationSnapshot {
  return {
    city: normalizeLocationValue(property.city),
    state: normalizeLocationValue(property.state),
    pincode: normalizeLocationValue(property.pincode),
    locality: normalizeLocationValue(property.locality),
  };
}
