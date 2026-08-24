import { randomBytes } from 'crypto';

/**
 * PLACEHOLDER — no inquiry-number generation strategy is defined anywhere
 * in the authoritative documents (same situation as propertyCode; see
 * properties/property-code.util.ts). `inquiry_number` is NOT NULL UNIQUE
 * in schema.sql but is not part of CreateInquiryRequest, so something
 * must generate one server-side.
 *
 * Generates `INQ-` followed by 8 random uppercase hex characters.
 * Deliberately simple per instructions; flagged for confirmation rather
 * than treated as final business logic. Collisions are checked and
 * retried by the caller (InquiriesService.resolveInquiryNumber).
 */
export function generateInquiryNumber(): string {
  return `INQ-${randomBytes(4).toString('hex').toUpperCase()}`;
}
