import { apiPost } from './client';
import type {
  PublicGeneralInquiryFields,
  PublicInquiryContactFields,
  PublicInquiryResponseData,
} from '../types/inquiry';

/**
 * POST /public/properties/:propertyId/inquiries — always creates a
 * BUYER inquiry server-side; `contact` has no `type` field to send in
 * the first place (see types/inquiry.ts), so there's no way for a
 * caller of this function to accidentally send one.
 */
export async function submitPropertyInquiry(
  propertyId: string,
  contact: PublicInquiryContactFields,
): Promise<PublicInquiryResponseData> {
  return apiPost<PublicInquiryResponseData>(
    `public/properties/${encodeURIComponent(propertyId)}/inquiries`,
    contact,
  );
}

/**
 * Phase 45D — POST /public/inquiries, the Contact Us / general flow.
 * No property is associated (this function has no propertyId parameter
 * at all — there is nowhere for a caller to even attempt to pass one);
 * the caller explicitly supplies `type` (BUYER or SELLER).
 */
export async function submitGeneralInquiry(
  contact: PublicGeneralInquiryFields,
): Promise<PublicInquiryResponseData> {
  return apiPost<PublicInquiryResponseData>('public/inquiries', contact);
}
