/**
 * Mirrors the backend's public inquiry endpoints exactly (Phase 45B —
 * see D:\aryan-landmark\backend\src\worker\routes\public-inquiries.ts
 * and docs/api/openapi.yaml's PublicPropertyInquiryRequest/
 * PublicGeneralInquiryRequest/PublicInquiryResponse schemas).
 */

export interface PublicInquiryContactFields {
  name: string;
  mobile: string;
  email?: string;
  message: string;
}

/**
 * Phase 45D — the Contact Us / general inquiry shape: the same contact
 * fields, plus a required `type`. Deliberately NOT used by the
 * property-specific "I'm Interested" flow (PropertyInquiryForm.tsx,
 * Phase 45C) — that endpoint never accepts a `type` field at all, and
 * continues to send exactly `PublicInquiryContactFields`, unchanged by
 * this phase.
 */
export type InquiryType = 'BUYER' | 'SELLER';

export interface PublicGeneralInquiryFields extends PublicInquiryContactFields {
  type: InquiryType;
}

export interface PublicInquiryResponseData {
  message: string;
}

// Matches the backend's own validation limits exactly (parseContactFields
// in public-inquiries.ts) — used for client-side pre-validation only;
// the server re-validates independently regardless.
export const INQUIRY_NAME_MAX = 150;
export const INQUIRY_MOBILE_MAX = 20;
export const INQUIRY_EMAIL_MAX = 255;
export const INQUIRY_MESSAGE_MAX = 1500;
