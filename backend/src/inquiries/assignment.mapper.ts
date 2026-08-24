/** Matches components.schemas.Assignment in docs/api/openapi.yaml exactly. */
export interface PublicAssignment {
  id: string;
  inquiryId: string;
  assignedFromUserId: string | null;
  assignedToUserId: string;
  assignedAt: Date;
  reason: string | null;
  createdBy: string;
}

interface AssignmentRow {
  id: string;
  inquiryId: string;
  assignedFromUserId: string | null;
  assignedToUserId: string;
  assignedAt: Date;
  reason: string | null;
  createdByUserId: string;
}

export function toPublicAssignment(row: AssignmentRow): PublicAssignment {
  return {
    id: row.id,
    inquiryId: row.inquiryId,
    assignedFromUserId: row.assignedFromUserId,
    assignedToUserId: row.assignedToUserId,
    assignedAt: row.assignedAt,
    reason: row.reason,
    createdBy: row.createdByUserId,
  };
}
