import { InquiryUserSummary } from './inquiry.mapper';

/**
 * Matches components.schemas.Assignment in docs/api/openapi.yaml exactly.
 * Phase 18A: assignedFrom/assignedTo display names added alongside the
 * existing *UserId fields (kept for backward compatibility) — same
 * minimal {id, name} InquiryUserSummary shape Phase 14A already
 * introduced for Inquiry.handledBy/assignedTo, reused here rather than
 * inventing a second near-identical type.
 */
export interface PublicAssignment {
  id: string;
  inquiryId: string;
  assignedFromUserId: string | null;
  assignedFrom: InquiryUserSummary | null;
  assignedToUserId: string;
  assignedTo: InquiryUserSummary;
  assignedAt: Date;
  reason: string | null;
  createdBy: string;
}

interface AssignmentUserRelationRow {
  id: string;
  name: string;
}

interface AssignmentRow {
  id: string;
  inquiryId: string;
  assignedFromUserId: string | null;
  /** Populated via Prisma `include`/`select` where fetched, else omitted. */
  assignedFrom?: AssignmentUserRelationRow | null;
  assignedToUserId: string;
  /** Populated via Prisma `include`/`select` where fetched, else omitted. */
  assignedTo?: AssignmentUserRelationRow;
  assignedAt: Date;
  reason: string | null;
  createdByUserId: string;
}

export function toPublicAssignment(row: AssignmentRow): PublicAssignment {
  return {
    id: row.id,
    inquiryId: row.inquiryId,
    assignedFromUserId: row.assignedFromUserId,
    assignedFrom: row.assignedFrom
      ? { id: row.assignedFrom.id, name: row.assignedFrom.name }
      : null,
    assignedToUserId: row.assignedToUserId,
    // assignedTo is required (non-null) at the DB level; if the relation
    // wasn't fetched (row.assignedTo undefined), fall back to just the id
    // with an empty name rather than crash — defensive only, every actual
    // caller (InquiriesService.listAssignments) always fetches it.
    assignedTo: row.assignedTo
      ? { id: row.assignedTo.id, name: row.assignedTo.name }
      : { id: row.assignedToUserId, name: '' },
    assignedAt: row.assignedAt,
    reason: row.reason,
    createdBy: row.createdByUserId,
  };
}
