/**
 * GET /inquiries/{inquiryId}/matches response shape (Phase 11). Matches
 * components.schemas.InquiryMatch in docs/api/openapi.yaml exactly — an
 * explicit allow-list of only what Flutter's matching UI needs, never the
 * full customer/inquiry rows (no passwordHash, no internal ids beyond
 * what's needed to act on the match).
 */
export interface PublicInquiryMatch {
  inquiryId: string;
  customerId: string;
  customerName: string;
  customerMobile: string | null;
  preferredCity: string | null;
  preferredPincode: string | null;
  maxBudget: number | null;
  matchingScore: number;
}
