import { AttachmentTypeValue, DocumentTypeValue } from '../common/types/domain-enums';

/** Matches components.schemas.Attachment in docs/api/openapi.yaml exactly. */
export interface PublicAttachment {
  id: string;
  propertyId: string | null;
  inquiryId: string | null;
  attachmentType: AttachmentTypeValue;
  documentType: DocumentTypeValue | null;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number | null;
  r2Bucket: string;
  r2ObjectKey: string;
  fileUrl: string | null;
  isPrimary: boolean;
  displayOrder: number;
  uploadedBy: string;
  createdAt: Date;
}

interface AttachmentRow {
  id: string;
  propertyId: string | null;
  inquiryId: string | null;
  attachmentType: string;
  documentType: string | null;
  fileName: string;
  mimeType: string;
  fileSizeBytes: unknown; // BigInt at runtime — not JSON-serializable directly
  r2Bucket: string;
  r2ObjectKey: string;
  fileUrl: string | null;
  isPrimary: boolean;
  displayOrder: number;
  uploadedByUserId: string;
  createdAt: Date;
}

export function toPublicAttachment(row: AttachmentRow): PublicAttachment {
  return {
    id: row.id,
    propertyId: row.propertyId,
    inquiryId: row.inquiryId,
    attachmentType: row.attachmentType as AttachmentTypeValue,
    documentType: row.documentType as DocumentTypeValue | null,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSizeBytes === null ? null : Number(row.fileSizeBytes),
    r2Bucket: row.r2Bucket,
    r2ObjectKey: row.r2ObjectKey,
    fileUrl: row.fileUrl,
    isPrimary: row.isPrimary,
    displayOrder: row.displayOrder,
    uploadedBy: row.uploadedByUserId,
    createdAt: row.createdAt,
  };
}
