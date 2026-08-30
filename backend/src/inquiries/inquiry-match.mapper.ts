import { InquiryTypeValue } from '../common/types/domain-enums';

/**
 * GET /inquiries/{inquiryId}/matches response shape (Phase 11;
 * bidirectional as of Phase 19A; unified location fields this phase).
 * Matches components.schemas.InquiryMatch in docs/api/openapi.yaml
 * exactly — an explicit allow-list of only what Flutter's matching UI
 * needs, never the full customer/inquiry rows (no passwordHash, no
 * internal ids beyond what's needed to act on the match).
 *
 * inquiryType/propertyId are additive (Phase 19A). propertyId is the
 * matched inquiry's property, if any — populated for SELLER-type matches
 * (null for BUYER-type matches, since buyers don't have one) — lets the
 * client fetch GET /properties/{propertyId} for full detail rather than
 * this response duplicating property fields inline.
 *
 * city/state/pincode/locality (this phase, replacing preferredCity/
 * preferredPincode) are populated for BOTH match types now — unlike the
 * old buyer-only fields, these are meaningful regardless of whether the
 * matched entry is a BUYER or SELLER, since both sides now carry their
 * own location on the Inquiry row directly (no more "null for SELLER"
 * special-casing).
 */
export interface PublicInquiryMatch {
  inquiryId: string;
  inquiryType: InquiryTypeValue;
  customerId: string;
  customerName: string;
  customerMobile: string | null;
  propertyId: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  maxBudget: number | null;
  matchingScore: number;
}
