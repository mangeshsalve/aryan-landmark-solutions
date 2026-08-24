/**
 * Allow-list, not deny-list — only these MIME types are ever accepted,
 * per attachment type. Anything else (including any executable or
 * script MIME type) is rejected by construction, not by trying to
 * enumerate what's unsafe.
 */
const ALLOWED_MIME_TYPES: Record<'PHOTO' | 'DOCUMENT' | 'RECORDING', ReadonlySet<string>> = {
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

export function isAllowedMimeType(
  attachmentType: 'PHOTO' | 'DOCUMENT' | 'RECORDING',
  mimeType: string,
): boolean {
  return ALLOWED_MIME_TYPES[attachmentType].has(mimeType.toLowerCase());
}
