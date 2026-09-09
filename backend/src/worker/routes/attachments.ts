import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../types/bindings';
import { requireApplicationAuth, requireRoles } from '../middleware/auth';
import {
  AttachmentNotFoundError,
  FileSizeLimitExceededError,
  FileTypeNotAllowedError,
  ok,
  StorageFinalizationFailedError,
  StorageNotConfiguredError,
  ValidationError,
} from '../utils/response';
import { isValidUuid, newId, nowIso } from '../utils/id';
import { recordAudit } from '../utils/audit';
import {
  AttachmentType,
  generateObjectKey,
  isAllowedMimeType,
  objectKeyMatchesExpectedPrefix,
} from '../utils/attachment-rules';
import {
  createDownloadAuthorization,
  createUploadAuthorization,
  deleteObject,
  getBucketName,
  getPublicUrl,
  isR2Configured,
  verifyObject,
} from '../utils/r2';

/**
 * /api/v1/attachments — ported field-for-field from
 * AttachmentsController/AttachmentsService. Source of truth verified by
 * direct read this phase: attachments.controller.ts, attachments.service.ts,
 * attachment.mapper.ts, mime-types.ts, object-key.util.ts,
 * storage.service.ts, cloudflare-r2-storage.service.ts,
 * storage-not-configured.exception.ts.
 *
 * Deliberately does NOT implement the "ADMIN-created inquiry needs a
 * recording" rule — that's inquiry business logic, out of scope for this
 * phase (Inquiries isn't built yet), matching the real
 * AttachmentsService's own doc comment on this exact point.
 */

const ATTACHMENT_TYPES: AttachmentType[] = ['PHOTO', 'DOCUMENT', 'RECORDING'];
// Phase 38B: no longer a closed allow-list — documentType is free text
// (see parseUploadBody's validation below). These five are simply the
// values the Flutter UI's quick-pick list already sends; kept only as a
// comment for context, not enforced here anymore. The D1
// chk_attachment_document_type CHECK constraint never restricted values
// either (only non-null-iff-DOCUMENT), so this relaxation needs no
// migration: SEVEN_TWELVE, SALE_DEED, PROPERTY_CARD, NOC, OTHER.
const DOCUMENT_TYPE_MAX_LENGTH = 100;
const DEFAULT_MAX_FILE_SIZE_BYTES = 26_214_400; // 25MB — matches configuration.ts's default exactly

export interface AttachmentRow {
  id: string;
  property_id: string | null;
  inquiry_id: string | null;
  attachment_type: string;
  document_type: string | null;
  file_name: string;
  mime_type: string;
  file_size_bytes: number | null;
  r2_bucket: string;
  r2_object_key: string;
  file_url: string | null;
  is_primary: number;
  display_order: number;
  uploaded_by: string;
  created_at: string;
}

/**
 * Exported for reuse by routes/inquiries.ts's inquiry-detail view
 * (attachments: PublicAttachment[]) — same reasoning as
 * removeAttachmentInternal below: one canonical mapper, not a duplicate.
 */
export function toPublicAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    propertyId: row.property_id,
    inquiryId: row.inquiry_id,
    attachmentType: row.attachment_type,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    r2Bucket: row.r2_bucket,
    r2ObjectKey: row.r2_object_key,
    fileUrl: row.file_url,
    isPrimary: Boolean(row.is_primary),
    displayOrder: row.display_order,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

export const ATTACHMENT_COLUMNS =
  'id, property_id, inquiry_id, attachment_type, document_type, file_name, mime_type, file_size_bytes, r2_bucket, r2_object_key, file_url, is_primary, display_order, uploaded_by, created_at';

interface AttachmentUploadInput {
  attachmentType: AttachmentType;
  propertyId?: string;
  inquiryId?: string;
  documentType?: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  isPrimary?: boolean;
}

/** Matches CreateAttachmentUploadDto exactly. */
function parseUploadBody(body: unknown): AttachmentUploadInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const b = body as Record<string, unknown>;

  if (
    typeof b.attachmentType !== 'string' ||
    !ATTACHMENT_TYPES.includes(b.attachmentType as AttachmentType)
  ) {
    throw new ValidationError(`attachmentType must be one of ${ATTACHMENT_TYPES.join(', ')}.`);
  }
  if (
    b.propertyId !== undefined &&
    (typeof b.propertyId !== 'string' || !isValidUuid(b.propertyId))
  ) {
    throw new ValidationError('propertyId must be a UUID.');
  }
  if (b.inquiryId !== undefined && (typeof b.inquiryId !== 'string' || !isValidUuid(b.inquiryId))) {
    throw new ValidationError('inquiryId must be a UUID.');
  }
  // Phase 38B: free-text document type — required non-empty (after
  // trimming) and capped at DOCUMENT_TYPE_MAX_LENGTH when provided, but
  // no longer restricted to a fixed set of values. The stored/forwarded
  // value is the *trimmed* string, never the raw (possibly
  // whitespace-padded) input, and never silently truncated — an
  // over-length value is rejected outright, not cut down.
  let documentType: string | undefined;
  if (b.documentType !== undefined) {
    if (typeof b.documentType !== 'string') {
      throw new ValidationError('documentType must be a string.');
    }
    const trimmed = b.documentType.trim();
    if (trimmed.length < 1) {
      throw new ValidationError('documentType must not be empty.');
    }
    if (trimmed.length > DOCUMENT_TYPE_MAX_LENGTH) {
      throw new ValidationError(`documentType must be ${DOCUMENT_TYPE_MAX_LENGTH} characters or fewer.`);
    }
    documentType = trimmed;
  }
  if (typeof b.fileName !== 'string' || b.fileName.length < 1 || b.fileName.length > 255) {
    throw new ValidationError('fileName is required (1-255 characters).');
  }
  if (typeof b.mimeType !== 'string' || b.mimeType.length < 1 || b.mimeType.length > 150) {
    throw new ValidationError('mimeType is required (1-150 characters).');
  }
  if (
    typeof b.fileSizeBytes !== 'number' ||
    !Number.isInteger(b.fileSizeBytes) ||
    b.fileSizeBytes < 1
  ) {
    throw new ValidationError('fileSizeBytes must be a positive integer.');
  }
  if (b.isPrimary !== undefined && typeof b.isPrimary !== 'boolean') {
    throw new ValidationError('isPrimary must be a boolean.');
  }

  return {
    attachmentType: b.attachmentType as AttachmentType,
    propertyId: b.propertyId as string | undefined,
    inquiryId: b.inquiryId as string | undefined,
    documentType,
    fileName: b.fileName,
    mimeType: b.mimeType,
    fileSizeBytes: b.fileSizeBytes,
    isPrimary: b.isPrimary as boolean | undefined,
  };
}

/** Matches FinalizeAttachmentDto exactly: everything above plus r2ObjectKey. */
function parseFinalizeBody(body: unknown): AttachmentUploadInput & { r2ObjectKey: string } {
  const base = parseUploadBody(body);
  const b = body as Record<string, unknown>;
  if (
    typeof b.r2ObjectKey !== 'string' ||
    b.r2ObjectKey.length < 1 ||
    b.r2ObjectKey.length > 1024
  ) {
    throw new ValidationError('r2ObjectKey is required (1-1024 characters).');
  }
  return { ...base, r2ObjectKey: b.r2ObjectKey };
}

/**
 * Matches AttachmentsService.validateRelationshipAndResource() exactly —
 * enforces chk_attachment_relationship/chk_attachment_document_type at the
 * application layer, plus existence of the referenced property/inquiry,
 * shared by createUploadUrl and finalize so the rule can't drift.
 */
async function validateRelationshipAndResource(
  db: D1Database,
  input: Pick<
    AttachmentUploadInput,
    'attachmentType' | 'propertyId' | 'inquiryId' | 'documentType'
  >,
): Promise<void> {
  if (input.attachmentType === 'PHOTO' || input.attachmentType === 'DOCUMENT') {
    if (!input.propertyId && !input.inquiryId) {
      throw new ValidationError(
        `Either propertyId or inquiryId is required when attachmentType is ${input.attachmentType}.`,
      );
    }
    if (input.propertyId && input.inquiryId) {
      throw new ValidationError(
        `propertyId and inquiryId must not both be set when attachmentType is ${input.attachmentType}.`,
      );
    }

    if (input.propertyId) {
      const property = await db
        .prepare('SELECT id FROM properties WHERE id = ?')
        .bind(input.propertyId)
        .first();
      if (!property) {
        throw new ValidationError('propertyId does not reference an existing property.');
      }
    } else {
      const inquiry = await db
        .prepare('SELECT id FROM inquiries WHERE id = ?')
        .bind(input.inquiryId)
        .first();
      if (!inquiry) {
        throw new ValidationError('inquiryId does not reference an existing inquiry.');
      }
    }
  }

  if (input.attachmentType === 'DOCUMENT' && !input.documentType) {
    throw new ValidationError('documentType is required when attachmentType is DOCUMENT.');
  }
  if (input.attachmentType !== 'DOCUMENT' && input.documentType) {
    throw new ValidationError('documentType must not be set unless attachmentType is DOCUMENT.');
  }

  if (input.attachmentType === 'RECORDING') {
    if (!input.inquiryId) {
      throw new ValidationError('inquiryId is required when attachmentType is RECORDING.');
    }
    if (input.propertyId) {
      throw new ValidationError('propertyId must not be set when attachmentType is RECORDING.');
    }
    const inquiry = await db
      .prepare('SELECT id FROM inquiries WHERE id = ?')
      .bind(input.inquiryId)
      .first();
    if (!inquiry) {
      throw new ValidationError('inquiryId does not reference an existing inquiry.');
    }
  }
}

function validateMimeAndSize(
  env: Bindings,
  attachmentType: AttachmentType,
  mimeType: string,
  fileSizeBytes: number,
): void {
  if (!isAllowedMimeType(attachmentType, mimeType)) {
    throw new FileTypeNotAllowedError(
      `mimeType "${mimeType}" is not allowed for attachmentType ${attachmentType}.`,
    );
  }
  const maxBytes = env.ATTACHMENT_MAX_FILE_SIZE_BYTES
    ? parseInt(env.ATTACHMENT_MAX_FILE_SIZE_BYTES, 10)
    : DEFAULT_MAX_FILE_SIZE_BYTES;
  if (fileSizeBytes > maxBytes) {
    throw new FileSizeLimitExceededError(
      `fileSizeBytes exceeds the configured limit of ${maxBytes} bytes.`,
    );
  }
}

/**
 * Shared by the DELETE route and PropertiesService's property-delete
 * cascade (see routes/properties.ts) — exported so property deletion can
 * remove each linked attachment through the exact same R2-then-DB-then-
 * audit sequence as a direct DELETE /attachments/:id call, matching
 * PropertiesService.delete()'s own reliance on
 * AttachmentsService.remove() rather than a bare SQL cascade.
 *
 * Order matches AttachmentsService.remove() exactly: the metadata row is
 * only deleted after the R2 object-delete call succeeds — a failure here
 * (including "R2 not configured", the only state reachable in this local
 * environment) never gets reported as a successful delete, and never
 * leaves a DB row with no backing object.
 */
export async function removeAttachmentInternal(
  env: Bindings,
  db: D1Database,
  id: string,
  actor: { userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  const attachment = await db
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`)
    .bind(id)
    .first<AttachmentRow>();
  if (!attachment) throw new AttachmentNotFoundError();

  if (!isR2Configured(env)) throw new StorageNotConfiguredError();
  await deleteObject(env, attachment.r2_object_key);

  await db.prepare('DELETE FROM attachments WHERE id = ?').bind(id).run();

  await recordAudit(db, {
    userId: actor.userId,
    entityType: 'ATTACHMENT',
    entityId: id,
    action: 'ATTACHMENT_DELETED',
    oldValues: {
      attachmentType: attachment.attachment_type,
      propertyId: attachment.property_id,
      inquiryId: attachment.inquiry_id,
      fileName: attachment.file_name,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export const attachmentsRoutes = new Hono<AppEnv>();

const staff = [requireApplicationAuth, requireRoles('ADMIN', 'EMPLOYEE')] as const;

attachmentsRoutes.post('/attachments/upload-url', ...staff, async (c) => {
  const input = parseUploadBody(await c.req.json().catch(() => null));
  await validateRelationshipAndResource(c.env.DB, input);
  validateMimeAndSize(c.env, input.attachmentType, input.mimeType, input.fileSizeBytes);

  const objectKey = generateObjectKey({
    attachmentType: input.attachmentType,
    propertyId: input.propertyId,
    inquiryId: input.inquiryId,
    fileName: input.fileName,
  });

  if (!isR2Configured(c.env)) throw new StorageNotConfiguredError();
  const result = await createUploadAuthorization(c.env, { objectKey, contentType: input.mimeType });

  return c.json(ok(result));
});

attachmentsRoutes.post('/attachments', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const input = parseFinalizeBody(await c.req.json().catch(() => null));
  await validateRelationshipAndResource(c.env.DB, input);
  validateMimeAndSize(c.env, input.attachmentType, input.mimeType, input.fileSizeBytes);

  if (
    !objectKeyMatchesExpectedPrefix({
      objectKey: input.r2ObjectKey,
      attachmentType: input.attachmentType,
      propertyId: input.propertyId,
      inquiryId: input.inquiryId,
    })
  ) {
    throw new ValidationError(
      'r2ObjectKey does not match the expected location for this resource and attachment type.',
    );
  }

  if (!isR2Configured(c.env)) throw new StorageNotConfiguredError();
  const verification = await verifyObject(c.env, input.r2ObjectKey);
  if (!verification.exists) {
    throw new StorageFinalizationFailedError(
      'The expected object was not found in storage. Upload it before finalizing.',
    );
  }

  const bucket = getBucketName(c.env);
  const fileUrl = getPublicUrl(c.env, input.r2ObjectKey) ?? null;
  const id = newId();
  const now = nowIso();
  const isPrimary = input.attachmentType === 'PHOTO' ? Boolean(input.isPrimary) : false;

  // uq_property_primary_photo is a partial unique index D1 enforces
  // directly, but the "unset the previous primary first" step (matching
  // Prisma's $transaction in AttachmentsService.finalize()) still needs
  // two statements to run atomically. Neither statement depends on the
  // other's result, so db.batch() — not an interactive transaction — is
  // the right tool here (see this phase's instructions on batch() vs.
  // arbitrary interactive logic).
  const statements = [];
  if (input.attachmentType === 'PHOTO' && input.isPrimary) {
    statements.push(
      input.propertyId
        ? c.env.DB.prepare(
            "UPDATE attachments SET is_primary = 0 WHERE property_id = ? AND attachment_type = 'PHOTO' AND is_primary = 1",
          ).bind(input.propertyId)
        : c.env.DB.prepare(
            "UPDATE attachments SET is_primary = 0 WHERE inquiry_id = ? AND attachment_type = 'PHOTO' AND is_primary = 1",
          ).bind(input.inquiryId),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO attachments (
        id, property_id, inquiry_id, attachment_type, document_type, file_name, mime_type,
        file_size_bytes, r2_bucket, r2_object_key, file_url, is_primary, display_order, uploaded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      id,
      input.propertyId ?? null,
      input.inquiryId ?? null,
      input.attachmentType,
      input.documentType ?? null,
      input.fileName,
      input.mimeType,
      input.fileSizeBytes,
      bucket ?? '',
      input.r2ObjectKey,
      fileUrl,
      isPrimary ? 1 : 0,
      applicationUser.sub,
      now,
    ),
  );

  await c.env.DB.batch(statements);

  await recordAudit(c.env.DB, {
    userId: applicationUser.sub,
    entityType: 'ATTACHMENT',
    entityId: id,
    action: 'ATTACHMENT_UPLOADED',
    newValues: {
      attachmentType: input.attachmentType,
      propertyId: input.propertyId ?? null,
      inquiryId: input.inquiryId ?? null,
      fileName: input.fileName,
    },
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  const row = await c.env.DB.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`)
    .bind(id)
    .first<AttachmentRow>();
  return c.json(ok(toPublicAttachment(row!)), 201);
});

/**
 * Phase 27 — GET /attachments/:attachmentId/download-url. The read-side
 * counterpart to POST /attachments/upload-url: same auth (staff-only,
 * same as every other attachment/property route — no additional
 * ownership restriction is introduced beyond what GET /attachments and
 * the now-embedded property-detail attachments already expose to any
 * ADMIN/EMPLOYEE), same "resolve the object key from the trusted DB
 * record, never trust one from the client" discipline as finalize's
 * r2ObjectKey-prefix check. The client sends only an attachmentId; the
 * actual R2 object key never appears in the request, only in the
 * response's signed URL.
 *
 * Deliberately placed before the parameterless GET /attachments below —
 * both this route and that one start with '/attachments', and Hono
 * matches in registration order, so the more specific path must come
 * first (not that '/attachments' would actually match '/attachments/:id/
 * download-url' — this ordering note is for the next person editing this
 * file, not a bug fix).
 */
attachmentsRoutes.get('/attachments/:attachmentId/download-url', ...staff, async (c) => {
  const id = c.req.param('attachmentId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  const attachment = await c.env.DB.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`,
  )
    .bind(id)
    .first<AttachmentRow>();
  if (!attachment) throw new AttachmentNotFoundError();

  if (!isR2Configured(c.env)) throw new StorageNotConfiguredError();
  const result = await createDownloadAuthorization(c.env, attachment.r2_object_key);

  return c.json(ok(result));
});

attachmentsRoutes.get('/attachments', ...staff, async (c) => {
  const propertyId = c.req.query('propertyId');
  const inquiryId = c.req.query('inquiryId');
  const attachmentType = c.req.query('attachmentType');

  if (attachmentType && !ATTACHMENT_TYPES.includes(attachmentType as AttachmentType)) {
    throw new ValidationError(`attachmentType must be one of ${ATTACHMENT_TYPES.join(', ')}.`);
  }
  if (propertyId && !isValidUuid(propertyId))
    throw new ValidationError('propertyId must be a UUID.');
  if (inquiryId && !isValidUuid(inquiryId)) throw new ValidationError('inquiryId must be a UUID.');

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (propertyId) {
    conditions.push('property_id = ?');
    params.push(propertyId);
  }
  if (inquiryId) {
    conditions.push('inquiry_id = ?');
    params.push(inquiryId);
  }
  if (attachmentType) {
    conditions.push('attachment_type = ?');
    params.push(attachmentType);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments ${where} ORDER BY display_order ASC, created_at DESC`,
  )
    .bind(...params)
    .all();

  // No pagination — AttachmentListResponse has no `pagination` field,
  // unlike customers/properties (see list-attachments-query.dto.ts).
  return c.json(ok((rows.results as unknown as AttachmentRow[]).map(toPublicAttachment)));
});

attachmentsRoutes.delete('/attachments/:attachmentId', ...staff, async (c) => {
  const applicationUser = c.get('applicationUser')!;
  const id = c.req.param('attachmentId');
  if (!isValidUuid(id)) throw new ValidationError('Validation failed (uuid is expected)');

  await removeAttachmentInternal(c.env, c.env.DB, id, {
    userId: applicationUser.sub,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });

  return c.body(null, 204);
});
