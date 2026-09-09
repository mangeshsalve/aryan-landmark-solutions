/**
 * Ported verbatim (logic-for-logic) from src/attachments/mime-types.ts
 * and src/attachments/object-key.util.ts — these are pure functions with
 * no NestJS/Prisma dependency, so the only change needed for the Worker
 * runtime is using the global Web Crypto `crypto.randomUUID()` instead of
 * Node's `crypto` module import. Business rules (allowed MIME types per
 * attachment type, object-key structure, prefix-matching for finalize)
 * are unchanged — do not add/remove a MIME type or reshape a key here
 * without the same change existing in the real backend first.
 */

export type AttachmentType = 'PHOTO' | 'DOCUMENT' | 'RECORDING';

const ALLOWED_MIME_TYPES: Record<AttachmentType, ReadonlySet<string>> = {
  PHOTO: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  DOCUMENT: new Set(['application/pdf', 'image/jpeg', 'image/png']),
  RECORDING: new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/webm',
  ]),
};

export function isAllowedMimeType(attachmentType: AttachmentType, mimeType: string): boolean {
  return ALLOWED_MIME_TYPES[attachmentType].has(mimeType.toLowerCase());
}

const SAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;
const MAX_SAFE_FILENAME_LENGTH = 100;

export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const cleaned = base.replace(SAFE_FILENAME_CHARS, '_');
  const truncated = cleaned.slice(0, MAX_SAFE_FILENAME_LENGTH);
  return truncated.length > 0 ? truncated : 'file';
}

export function generateObjectKey(params: {
  attachmentType: AttachmentType;
  propertyId?: string;
  inquiryId?: string;
  fileName: string;
}): string {
  const safeFileName = sanitizeFileName(params.fileName);
  const uuid = crypto.randomUUID();

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

export function objectKeyMatchesExpectedPrefix(params: {
  objectKey: string;
  attachmentType: AttachmentType;
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
