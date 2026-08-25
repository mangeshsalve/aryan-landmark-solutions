import { randomUUID } from 'crypto';

const SAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;
const MAX_SAFE_FILENAME_LENGTH = 100;

/**
 * Strips anything that isn't alphanumeric/dot/dash/underscore, collapses
 * path separators, and truncates — defends against path traversal
 * (`../`), null bytes, and absurdly long names. The backend generates the
 * final object key (see generateObjectKey); this only sanitizes the
 * human-readable suffix, it never becomes the whole key.
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const cleaned = base.replace(SAFE_FILENAME_CHARS, '_');
  const truncated = cleaned.slice(0, MAX_SAFE_FILENAME_LENGTH);
  return truncated.length > 0 ? truncated : 'file';
}

export type ObjectKeyAttachmentType = 'PHOTO' | 'DOCUMENT' | 'RECORDING';

/**
 * Backend-generated R2 object key — the client never supplies or chooses
 * this. Structure per this phase's spec:
 *   properties/{propertyId}/photos/{uuid}-{safeFileName}
 *   properties/{propertyId}/documents/{uuid}-{safeFileName}
 *   inquiries/{inquiryId}/photos/{uuid}-{safeFileName}
 *   inquiries/{inquiryId}/documents/{uuid}-{safeFileName}
 *   inquiries/{inquiryId}/recordings/{uuid}-{safeFileName}
 *
 * Phase 13B: PHOTO/DOCUMENT route under inquiries/{inquiryId}/... when no
 * propertyId is given (the lightweight ADMIN-call-capture flow) — the
 * caller (AttachmentsService.validateRelationshipAndResource) already
 * guarantees exactly one of propertyId/inquiryId is set for these types.
 */
export function generateObjectKey(params: {
  attachmentType: ObjectKeyAttachmentType;
  propertyId?: string;
  inquiryId?: string;
  fileName: string;
}): string {
  const safeFileName = sanitizeFileName(params.fileName);
  const uuid = randomUUID();

  switch (params.attachmentType) {
    case 'PHOTO':
      return params.propertyId
        ? `properties/${params.propertyId}/photos/${uuid}-${safeFileName}`
        : `inquiries/${params.inquiryId}/photos/${uuid}-${safeFileName}`;
    case 'DOCUMENT':
      return params.propertyId
        ? `properties/${params.propertyId}/documents/${uuid}-${safeFileName}`
        : `inquiries/${params.inquiryId}/documents/${uuid}-${safeFileName}`;
    case 'RECORDING':
      return `inquiries/${params.inquiryId}/recordings/${uuid}-${safeFileName}`;
  }
}

/**
 * Confirms a client-echoed r2ObjectKey (in the finalize step) actually
 * matches the prefix this backend would have generated for the given
 * resource/type — the practical safeguard against a client substituting
 * an unrelated key, given the documented flow requires the client to
 * pass the key back rather than a server-held pending-upload record.
 */
export function objectKeyMatchesExpectedPrefix(params: {
  objectKey: string;
  attachmentType: ObjectKeyAttachmentType;
  propertyId?: string;
  inquiryId?: string;
}): boolean {
  if (params.objectKey.includes('..') || params.objectKey.startsWith('/')) {
    return false;
  }

  const subfolder = params.attachmentType === 'PHOTO' ? 'photos' : 'documents';
  const expectedPrefix =
    params.attachmentType === 'RECORDING'
      ? `inquiries/${params.inquiryId}/recordings/`
      : params.propertyId
        ? `properties/${params.propertyId}/${subfolder}/`
        : `inquiries/${params.inquiryId}/${subfolder}/`;

  return params.objectKey.startsWith(expectedPrefix);
}
