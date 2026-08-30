import { FollowUpStatusValue } from '../common/types/domain-enums';

/** Matches components.schemas.FollowUp in docs/api/openapi.yaml exactly. */
export interface PublicFollowUp {
  id: string;
  inquiryId: string;
  scheduledAt: Date;
  status: FollowUpStatusValue;
  notes: string | null;
  reminderEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FollowUpRow {
  id: string;
  inquiryId: string;
  scheduledAt: Date;
  status: string;
  notes: string | null;
  reminderEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicFollowUp(row: FollowUpRow): PublicFollowUp {
  return {
    id: row.id,
    inquiryId: row.inquiryId,
    scheduledAt: row.scheduledAt,
    status: row.status as FollowUpStatusValue,
    notes: row.notes,
    reminderEnabled: row.reminderEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /follow-ups/today (Phase 16A Part 6) — deliberately minimal, not
 * the full Inquiry/User schemas: id+name only for the customer (same
 * "label-only embedding" reasoning as InquiryUserSummary in
 * inquiries/inquiry.mapper.ts, Phase 14A) — no mobile/email, since
 * click-to-call from the dashboard wasn't a confirmed requirement. `null`
 * when the inquiry is still in its lightweight, customer-less state (see
 * FollowUpsService.listToday).
 */
export interface FollowUpInquirySummary {
  id: string;
  inquiryNumber: string;
  status: string;
  customer: { id: string; name: string } | null;
}

export interface PublicFollowUpWithInquiry extends PublicFollowUp {
  inquiry: FollowUpInquirySummary;
}

interface FollowUpWithInquiryRow extends FollowUpRow {
  inquiry: {
    id: string;
    inquiryNumber: string;
    status: string;
    customer: { id: string; name: string } | null;
  };
}

export function toPublicFollowUpWithInquiry(
  row: FollowUpWithInquiryRow,
): PublicFollowUpWithInquiry {
  return {
    ...toPublicFollowUp(row),
    inquiry: {
      id: row.inquiry.id,
      inquiryNumber: row.inquiry.inquiryNumber,
      status: row.inquiry.status,
      customer: row.inquiry.customer,
    },
  };
}
