/**
 * Phase 39 (#11) — mirrors generatePropertyCode()/generateInquiryNumber()
 * exactly: same randomness/format convention (`PREFIX-` + 8 random
 * uppercase hex chars), so all three business codes stay consistent with
 * each other. Not sequential, not derived from row order — see those two
 * generators' own doc comments for why (no ROW_NUMBER-based scheme, per
 * this phase's explicit instruction). Collisions are checked and
 * retried by the caller, same as the other two.
 */
export function generateCustomerCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `CUST-${hex.toUpperCase()}`;
}
