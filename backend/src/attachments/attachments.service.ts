import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AttachmentNotFoundException,
  AttachmentRelationshipInvalidException,
  FileSizeLimitExceededException,
  FileTypeNotAllowedException,
  StorageFinalizationFailedException,
} from '../common/exceptions/app.exception';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService, UploadAuthorization } from '../storage/storage.service';
import { toPublicAttachment, PublicAttachment } from './attachment.mapper';
import { CreateAttachmentUploadDto } from './dto/create-attachment-upload.dto';
import { FinalizeAttachmentDto } from './dto/finalize-attachment.dto';
import { ListAttachmentsQueryDto } from './dto/list-attachments-query.dto';
import { isAllowedMimeType } from './mime-types';
import { generateObjectKey, objectKeyMatchesExpectedPrefix } from './object-key.util';

interface Actor {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Unified attachment storage (PHOTO/DOCUMENT/RECORDING), backed by the
 * single `attachments` table and Cloudflare R2 for binaries. Depends on
 * StorageService (the abstraction), never on the R2/AWS SDK directly —
 * see src/storage/.
 *
 * Deliberately does NOT implement the "ADMIN-created inquiry needs a
 * recording" rule — that's inquiry business logic, out of scope for this
 * phase per its instructions. This only provides the RECORDING
 * attachment-type infrastructure.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {}

  async createUploadUrl(
    dto: CreateAttachmentUploadDto,
    _actor: Actor,
  ): Promise<UploadAuthorization> {
    await this.validateRelationshipAndResource(dto);
    this.validateMimeAndSize(dto.attachmentType, dto.mimeType, dto.fileSizeBytes);

    const objectKey = generateObjectKey({
      attachmentType: dto.attachmentType,
      propertyId: dto.propertyId,
      inquiryId: dto.inquiryId,
      fileName: dto.fileName,
    });

    // Throws StorageNotConfiguredException if R2 credentials aren't set —
    // propagates as-is, no fallback.
    return this.storageService.createUploadAuthorization({
      objectKey,
      contentType: dto.mimeType,
      contentLength: dto.fileSizeBytes,
    });
  }

  async finalize(dto: FinalizeAttachmentDto, actor: Actor): Promise<PublicAttachment> {
    await this.validateRelationshipAndResource(dto);
    this.validateMimeAndSize(dto.attachmentType, dto.mimeType, dto.fileSizeBytes);

    if (
      !objectKeyMatchesExpectedPrefix({
        objectKey: dto.r2ObjectKey,
        attachmentType: dto.attachmentType,
        propertyId: dto.propertyId,
        inquiryId: dto.inquiryId,
      })
    ) {
      throw new AttachmentRelationshipInvalidException(
        'r2ObjectKey does not match the expected location for this resource and attachment type.',
      );
    }

    // Throws StorageNotConfiguredException if R2 isn't configured — a
    // successful attachment row is never created in that case, per this
    // phase's instructions.
    const verification = await this.storageService.verifyObject({
      objectKey: dto.r2ObjectKey,
      expectedSizeBytes: dto.fileSizeBytes,
    });

    if (!verification.exists) {
      throw new StorageFinalizationFailedException(
        'The expected object was not found in storage. Upload it before finalizing.',
      );
    }

    const bucket = this.storageService.getBucketName();
    const fileUrl = this.storageService.getPublicUrl(dto.r2ObjectKey) ?? null;

    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // uq_property_primary_photo (schema.sql) is a partial unique index
      // Prisma's DSL can't express and — since no migration has ever run
      // in this environment (see Phase 5 report) — isn't guaranteed to
      // exist at the database level yet either. Enforced here in the
      // meantime: unset any existing primary photo for this property
      // before inserting a new primary one, inside the same transaction.
      if (dto.attachmentType === 'PHOTO' && dto.isPrimary) {
        await tx.attachment.updateMany({
          where: { propertyId: dto.propertyId, attachmentType: 'PHOTO', isPrimary: true },
          data: { isPrimary: false },
        });
      }

      return tx.attachment.create({
        data: {
          propertyId: dto.propertyId ?? null,
          inquiryId: dto.inquiryId ?? null,
          attachmentType: dto.attachmentType,
          documentType: dto.documentType ?? null,
          fileName: dto.fileName,
          mimeType: dto.mimeType,
          fileSizeBytes: BigInt(dto.fileSizeBytes),
          r2Bucket: bucket ?? '',
          r2ObjectKey: dto.r2ObjectKey,
          fileUrl,
          isPrimary: dto.attachmentType === 'PHOTO' ? Boolean(dto.isPrimary) : false,
          uploadedByUserId: actor.userId,
        },
      });
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'ATTACHMENT',
      entityId: created.id,
      action: 'ATTACHMENT_UPLOADED',
      newValues: {
        attachmentType: dto.attachmentType,
        propertyId: dto.propertyId,
        inquiryId: dto.inquiryId,
        fileName: dto.fileName,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicAttachment(created);
  }

  async list(query: ListAttachmentsQueryDto): Promise<PublicAttachment[]> {
    const where: Record<string, unknown> = {};
    if (query.propertyId) where.propertyId = query.propertyId;
    if (query.inquiryId) where.inquiryId = query.inquiryId;
    if (query.attachmentType) where.attachmentType = query.attachmentType;

    const rows = await this.prisma.attachment.findMany({
      where,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    });

    return rows.map(toPublicAttachment);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) {
      throw new AttachmentNotFoundException();
    }

    // Throws StorageNotConfiguredException (or a real R2 error once
    // configured) if deletion can't be confirmed — the metadata row is
    // only removed after the object deletion call succeeds, so a failure
    // here never gets reported as a successful delete.
    await this.storageService.deleteObject(attachment.r2ObjectKey);

    await this.prisma.attachment.delete({ where: { id } });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'ATTACHMENT',
      entityId: id,
      action: 'ATTACHMENT_DELETED',
      oldValues: {
        attachmentType: attachment.attachmentType,
        propertyId: attachment.propertyId,
        inquiryId: attachment.inquiryId,
        fileName: attachment.fileName,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  /**
   * Enforces chk_attachment_relationship and chk_attachment_document_type
   * (schema.sql) at the application layer, plus existence of the
   * referenced property/inquiry. Shared by createUploadUrl and finalize
   * so the rule can't drift between the two steps.
   */
  private async validateRelationshipAndResource(dto: {
    attachmentType: 'PHOTO' | 'DOCUMENT' | 'RECORDING';
    propertyId?: string;
    inquiryId?: string;
    documentType?: string;
  }): Promise<void> {
    if (dto.attachmentType === 'PHOTO' || dto.attachmentType === 'DOCUMENT') {
      if (!dto.propertyId) {
        throw new AttachmentRelationshipInvalidException(
          `propertyId is required when attachmentType is ${dto.attachmentType}.`,
        );
      }
      if (dto.inquiryId) {
        throw new AttachmentRelationshipInvalidException(
          `inquiryId must not be set when attachmentType is ${dto.attachmentType}.`,
        );
      }

      const property = await this.prisma.property.findUnique({ where: { id: dto.propertyId } });
      if (!property) {
        throw new AttachmentRelationshipInvalidException(
          'propertyId does not reference an existing property.',
        );
      }
    }

    if (dto.attachmentType === 'DOCUMENT' && !dto.documentType) {
      throw new AttachmentRelationshipInvalidException(
        'documentType is required when attachmentType is DOCUMENT.',
      );
    }
    if (dto.attachmentType !== 'DOCUMENT' && dto.documentType) {
      throw new AttachmentRelationshipInvalidException(
        'documentType must not be set unless attachmentType is DOCUMENT.',
      );
    }

    if (dto.attachmentType === 'RECORDING') {
      if (!dto.inquiryId) {
        throw new AttachmentRelationshipInvalidException(
          'inquiryId is required when attachmentType is RECORDING.',
        );
      }
      if (dto.propertyId) {
        throw new AttachmentRelationshipInvalidException(
          'propertyId must not be set when attachmentType is RECORDING.',
        );
      }

      const inquiry = await this.prisma.inquiry.findUnique({ where: { id: dto.inquiryId } });
      if (!inquiry) {
        throw new AttachmentRelationshipInvalidException(
          'inquiryId does not reference an existing inquiry.',
        );
      }
    }
  }

  private validateMimeAndSize(
    attachmentType: 'PHOTO' | 'DOCUMENT' | 'RECORDING',
    mimeType: string,
    fileSizeBytes: number,
  ): void {
    if (!isAllowedMimeType(attachmentType, mimeType)) {
      throw new FileTypeNotAllowedException(
        `mimeType "${mimeType}" is not allowed for attachmentType ${attachmentType}.`,
      );
    }

    const app = this.configService.get<AppConfig>('app');
    const maxBytes = app?.attachmentMaxFileSizeBytes ?? 26_214_400;
    if (fileSizeBytes > maxBytes) {
      throw new FileSizeLimitExceededException(
        `fileSizeBytes exceeds the configured limit of ${maxBytes} bytes.`,
      );
    }
  }
}
