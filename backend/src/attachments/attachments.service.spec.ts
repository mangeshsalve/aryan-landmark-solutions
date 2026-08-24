import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import {
  AttachmentRelationshipInvalidException,
  FileSizeLimitExceededException,
  FileTypeNotAllowedException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageNotConfiguredException } from '../storage/storage-not-configured.exception';
import { AttachmentsService } from './attachments.service';

describe('AttachmentsService (critical paths)', () => {
  let service: AttachmentsService;
  let prisma: {
    property: { findUnique: jest.Mock };
    inquiry: { findUnique: jest.Mock };
    attachment: { findUnique: jest.Mock; findMany: jest.Mock; delete: jest.Mock };
  };
  let storage: {
    isConfigured: jest.Mock;
    createUploadAuthorization: jest.Mock;
    verifyObject: jest.Mock;
    deleteObject: jest.Mock;
    getBucketName: jest.Mock;
    getPublicUrl: jest.Mock;
  };
  let audit: { record: jest.Mock };

  const actor = { userId: 'admin-uuid-1' };

  beforeEach(async () => {
    prisma = {
      property: { findUnique: jest.fn() },
      inquiry: { findUnique: jest.fn() },
      attachment: { findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
    };
    storage = {
      isConfigured: jest.fn().mockReturnValue(false),
      createUploadAuthorization: jest.fn().mockRejectedValue(new StorageNotConfiguredException()),
      verifyObject: jest.fn(),
      deleteObject: jest.fn().mockRejectedValue(new StorageNotConfiguredException()),
      getBucketName: jest.fn().mockReturnValue(undefined),
      getPublicUrl: jest.fn().mockReturnValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: StorageService, useValue: storage },
        {
          provide: ConfigService,
          useValue: { get: () => ({ attachmentMaxFileSizeBytes: 26_214_400 }) },
        },
      ],
    }).compile();

    service = module.get(AttachmentsService);
  });

  // invalid resource relationship is rejected
  it('rejects a PHOTO upload-url request with no propertyId', async () => {
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'PHOTO',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          fileSizeBytes: 1000,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(AttachmentRelationshipInvalidException);
  });

  it('rejects a DOCUMENT upload-url request with no documentType', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'prop-1' });
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'DOCUMENT',
          propertyId: 'prop-1',
          fileName: 'doc.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 1000,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(AttachmentRelationshipInvalidException);
  });

  it('rejects a RECORDING upload-url request referencing a non-existent inquiry', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(null);
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'RECORDING',
          inquiryId: 'missing-inquiry',
          fileName: 'call.mp3',
          mimeType: 'audio/mpeg',
          fileSizeBytes: 1000,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(AttachmentRelationshipInvalidException);
  });

  // invalid file size is rejected
  it('rejects a file exceeding the configured size limit', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'prop-1' });
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'PHOTO',
          propertyId: 'prop-1',
          fileName: 'huge.jpg',
          mimeType: 'image/jpeg',
          fileSizeBytes: 999_999_999,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(FileSizeLimitExceededException);
  });

  // invalid MIME type is rejected
  it('rejects a disallowed MIME type for the given attachment type', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'prop-1' });
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'PHOTO',
          propertyId: 'prop-1',
          fileName: 'malware.exe',
          mimeType: 'application/x-msdownload',
          fileSizeBytes: 1000,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(FileTypeNotAllowedException);
  });

  // R2-not-configured produces a clear configuration error
  it('propagates StorageNotConfiguredException from createUploadUrl when R2 is unset', async () => {
    prisma.property.findUnique.mockResolvedValue({ id: 'prop-1' });
    await expect(
      service.createUploadUrl(
        {
          attachmentType: 'PHOTO',
          propertyId: 'prop-1',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          fileSizeBytes: 1000,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(StorageNotConfiguredException);
  });

  it('propagates StorageNotConfiguredException from remove() rather than deleting metadata', async () => {
    prisma.attachment.findUnique.mockResolvedValue({
      id: 'att-1',
      r2ObjectKey: 'properties/prop-1/photos/x-photo.jpg',
      attachmentType: 'PHOTO',
      propertyId: 'prop-1',
      inquiryId: null,
      fileName: 'photo.jpg',
    });

    await expect(service.remove('att-1', actor)).rejects.toBeInstanceOf(
      StorageNotConfiguredException,
    );
    expect(prisma.attachment.delete).not.toHaveBeenCalled();
  });

  // attachment metadata structure is correct
  it('maps a listed attachment row to the documented response shape', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      {
        id: 'att-1',
        propertyId: 'prop-1',
        inquiryId: null,
        attachmentType: 'PHOTO',
        documentType: null,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSizeBytes: BigInt(2048),
        r2Bucket: 'my-bucket',
        r2ObjectKey: 'properties/prop-1/photos/x-photo.jpg',
        fileUrl: null,
        isPrimary: true,
        displayOrder: 0,
        uploadedByUserId: 'admin-uuid-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const result = await service.list({});

    expect(result).toEqual([
      {
        id: 'att-1',
        propertyId: 'prop-1',
        inquiryId: null,
        attachmentType: 'PHOTO',
        documentType: null,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSizeBytes: 2048,
        r2Bucket: 'my-bucket',
        r2ObjectKey: 'properties/prop-1/photos/x-photo.jpg',
        fileUrl: null,
        isPrimary: true,
        displayOrder: 0,
        uploadedBy: 'admin-uuid-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    // fileSizeBytes must be a plain number, not the raw BigInt — required
    // for JSON serialization.
    expect(typeof result[0].fileSizeBytes).toBe('number');
  });
});
