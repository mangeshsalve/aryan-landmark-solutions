/**
 * Location normalization, fuzzy-matching, and Property→Inquiry sync
 * helpers (this phase — unified Inquiry.city/state/pincode/locality for
 * both BUYER and SELLER). Shared between InquiriesService (matching,
 * create/update sync) and PropertiesService (propagation to linked
 * SELLER inquiries on property edit) — a plain data-shape/pure-function
 * module, not an authorization or business-rule helper, so sharing it
 * across module boundaries doesn't cross the same line the project has
 * otherwise deliberately avoided for authorization checks (see
 * InquiriesService.assertCanModifyInquiry()'s doc comment).
 *
 * Matching algorithm (this phase, replacing the old city-only-mandatory
 * design):
 *  - pincode (30 pts): mandatory gate. Exact match after normalization
 *    (trim only — pincodes are numeric, no case-folding needed). No
 *    match ⇒ zero results, never scored, never returned.
 *  - location quality (up to 50 pts) = MAX(cityScore, localityScore):
 *      - city (50): normalized (trim, lowercase, collapsed whitespace,
 *        punctuation stripped) exact compare — not raw string equality.
 *      - locality (50): token-overlap fuzzy match after the same
 *        normalization, with short/numeric/stopword tokens filtered out
 *        (avoids false positives from generic words like "road"/
 *        "colony"/"highway" alone driving a match).
 *  - budget (20 pts): unchanged from before this phase — property.price
 *    <= inquiry.maxBudget, still asymmetric (SELLER's number always
 *    comes from its linked Property, BUYER's from Inquiry.maxBudget
 *    directly).
 *  - Threshold: 70/100 — unchanged, not being revisited here.
 *
 * Achievable score values (documentation only — a mathematical
 * consequence of the weights above, not a separate rule): pincode is
 * an all-or-nothing precondition for even reaching the scoring step (30
 * once gated), location is 0 or 50, budget is 0 or 20. The only totals
 * a gated candidate can ever produce are therefore 30, 50, 80, or 100 —
 * there is no way to score, say, 60 or 70 exactly. Since the threshold
 * is score >= 70, and 80 is the smallest of these four values that
 * clears it, the *effective* minimum passing score under the current
 * model is 80 (requiring the location criterion — city or locality —
 * to match; pincode plus budget alone, at 50, is never enough). This
 * doesn't change if the threshold or weights change; it's just what the
 * current 30/50/20-at-70 configuration happens to produce.
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

/**
 * Write-time normalization — trim + collapse internal whitespace, and an
 * empty-after-trim string becomes null (never stored as ""). Applied
 * wherever these fields are written: InquiriesService.create()/update()
 * for BUYER-entered (or propertyless-SELLER-entered) values, and here in
 * deriveSyncedLocationFromProperty() for SELLER-synced values — so every
 * stored value is already clean, and pincode's DB-level exact-match gate
 * (idx_inquiries_type_pincode) never has to account for whitespace at
 * read time.
 */
export function normalizeLocationValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Match-time normalization for city comparison — lowercase + punctuation
 * stripped (replaced with a space, not deleted, so "Alandi-Road" becomes
 * "alandi road", not "alandiroad"). Values are already whitespace-clean
 * from normalizeLocationValue() at write time, but this re-collapses
 * whitespace anyway since punctuation-to-space substitution can
 * reintroduce runs of spaces.
 */
function normalizeForCompare(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Tokenizes a locality string for fuzzy matching: normalize, split on
 * whitespace, drop tokens that are too short to be meaningful (<=2
 * chars), purely numeric (house/flat/plot numbers, or a pincode digit
 * string that leaked into free text), or a known generic/stopword term.
 */
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

/**
 * The location-quality score (up to 50) for a candidate against a
 * source, given each side's already-fetched city/locality strings.
 * MAX, not SUM, of the two signals — deliberately, so a locality that
 * happens to restate the city (or vice versa) doesn't get double credit,
 * and so a strong locality-token match can stand in for a city match
 * that's absent or recorded inconsistently between the two sides.
 */
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

export interface PropertyLocationSnapshot {
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
}

/**
 * The single Property→Inquiry sync rule (this phase, approved
 * explicitly): locality is sourced from Property.locality only — never
 * Property.address, even when locality is empty. A property with no
 * locality set leaves the inquiry's locality null; full free-text
 * address fuzzy matching was explicitly deferred, not silently added
 * here.
 */
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
