import {
  InquiryPriorityValue,
  InquiryStatusValue,
  InquiryTypeValue,
} from '../common/types/domain-enums';
import { PublicAttachment } from '../attachments/attachment.mapper';
import { PublicProperty } from '../properties/property.mapper';

/** Matches components.schemas.User in docs/api/openapi.yaml exactly. */
export interface InquiryCustomerSummary {
  id: string;
  userId: string | null;
  userType: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: string;
}

/** Matches components.schemas.Inquiry in docs/api/openapi.yaml exactly. */
export interface PublicInquiry {
  id: string;
  inquiryNumber: string;
  customerId: string;
  propertyId: string | null;
  type: InquiryTypeValue | null;
  priority: InquiryPriorityValue;
  status: InquiryStatusValue;
  externalReference: string | null;
  handledByUserId: string | null;
  assignedToUserId: string | null;
  remarks: string | null;
  isPublic: boolean;
  /** BUYER matching preferences (Phase 11) — see Phase 11 report Part 4/5/6. */
  preferredCity: string | null;
  preferredPincode: string | null;
  maxBudget: number | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Matches components.schemas.InquiryDetailResponse.data (allOf Inquiry + customer/property/attachments). */
export interface PublicInquiryDetail extends PublicInquiry {
  customer?: InquiryCustomerSummary;
  property?: PublicProperty | null;
  attachments: PublicAttachment[];
}

interface InquiryRow {
  id: string;
  inquiryNumber: string;
  customerId: string;
  propertyId: string | null;
  type: string | null;
  priority: string;
  status: string;
  externalReference: string | null;
  handledByUserId: string | null;
  assignedToUserId: string | null;
  remarks: string | null;
  isPublic: boolean;
  preferredCity: string | null;
  preferredPincode: string | null;
  maxBudget: unknown; // Prisma Decimal at runtime — not JSON-serializable directly
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function toPublicInquiry(row: InquiryRow): PublicInquiry {
  return {
    id: row.id,
    inquiryNumber: row.inquiryNumber,
    customerId: row.customerId,
    propertyId: row.propertyId,
    type: row.type as InquiryTypeValue | null,
    priority: row.priority as InquiryPriorityValue,
    status: row.status as InquiryStatusValue,
    externalReference: row.externalReference,
    handledByUserId: row.handledByUserId,
    assignedToUserId: row.assignedToUserId,
    remarks: row.remarks,
    isPublic: row.isPublic,
    preferredCity: row.preferredCity,
    preferredPincode: row.preferredPincode,
    maxBudget: toNullableNumber(row.maxBudget),
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface UserSummaryRow {
  id: string;
  userId: string | null;
  userType: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: string;
}

export function toInquiryCustomerSummary(user: UserSummaryRow): InquiryCustomerSummary {
  return {
    id: user.id,
    userId: user.userId,
    userType: user.userType,
    role: user.role,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    status: user.status,
  };
}
