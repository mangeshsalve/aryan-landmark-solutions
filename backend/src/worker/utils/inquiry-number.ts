/**
 * Ported verbatim from src/inquiries/inquiry-number.util.ts — same
 * flagged placeholder as property-code.util.ts (no format is defined in
 * any authoritative document). `INQ-` + 8 random uppercase hex chars.
 * Collisions are checked and retried by the caller.
 */
export function generateInquiryNumber(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `INQ-${hex.toUpperCase()}`;
}
