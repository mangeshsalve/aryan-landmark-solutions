import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import {
  InquiryAlreadySubmittedException,
  InquiryRecordingRequiredException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService.submit (critical paths)', () => {
  let service: InquiriesService;
  let prisma: {
    inquiry: { findUnique: jest.Mock; updateMany: jest.Mock };
    user: { findUnique: jest.Mock };
    attachment: { findMany: jest.Mock };
  };
  let attachments: { list: jest.Mock };
  let audit: { record: jest.Mock };

  const actor = { userId: 'submitter-uuid', role: 'EMPLOYEE' as const };

  const baseInquiry = {
    id: 'inq-1',
    createdByUserId: 'creator-uuid',
    customerId: 'cust-1',
    propertyId: null as string | null,
    submittedAt: null as Date | null,
  };

  beforeEach(async () => {
    prisma = {
      inquiry: { findUnique: jest.fn(), updateMany: jest.fn() },
      user: { findUnique: jest.fn() },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    attachments = { list: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: AttachmentsService, useValue: attachments },
      ],
    }).compile();

    service = module.get(InquiriesService);

    // getById()/toDetail() calls after a successful submit — not the
    // point of these tests, so stub the reads it makes.
    prisma.user.findUnique.mockResolvedValue({ role: 'EMPLOYEE' });
  });

  it('rejects submission when the creator is ADMIN and no recording exists', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(baseInquiry);
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN' }); // creator lookup
    attachments.list.mockResolvedValue([]);

    await expect(service.submit('inq-1', actor)).rejects.toBeInstanceOf(
      InquiryRecordingRequiredException,
    );
    expect(prisma.inquiry.updateMany).not.toHaveBeenCalled();
  });

  it('allows submission when the creator is ADMIN and a recording exists', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(baseInquiry);
    prisma.user.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' }) // creator lookup
      .mockResolvedValueOnce({ id: 'cust-1' }); // toDetail() customer lookup
    attachments.list.mockResolvedValue([{ id: 'rec-1', attachmentType: 'RECORDING' }]);
    prisma.inquiry.updateMany.mockResolvedValue({ count: 1 });

    await service.submit('inq-1', actor);

    // The atomic conditional update is what actually prevents a
    // double-submit — assert the WHERE clause carries submittedAt: null.
    expect(prisma.inquiry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inq-1', submittedAt: null },
        data: expect.objectContaining({ submittedAt: expect.any(Date) }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INQUIRY_SUBMITTED' }),
    );
  });

  it('allows submission when the creator is EMPLOYEE and no recording exists', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(baseInquiry);
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'EMPLOYEE' }); // creator lookup
    prisma.inquiry.updateMany.mockResolvedValue({ count: 1 });

    await service.submit('inq-1', actor);

    expect(attachments.list).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INQUIRY_SUBMITTED' }),
    );
  });

  it('rejects submitting an already-submitted inquiry (fast path, before any write)', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ ...baseInquiry, submittedAt: new Date() });

    await expect(service.submit('inq-1', actor)).rejects.toBeInstanceOf(
      InquiryAlreadySubmittedException,
    );
    expect(prisma.inquiry.updateMany).not.toHaveBeenCalled();
  });

  // Phase 9B: the actual concurrency guarantee. Simulates two requests
  // racing past the initial (non-atomic) reads — both see submittedAt as
  // NULL — and diverge only at the atomic updateMany, which a real
  // Postgres would only let one of them win.
  it('lets exactly one of two concurrent submits succeed, with exactly one audit event', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(baseInquiry); // both requests' initial read
    prisma.user.findUnique.mockResolvedValue({ role: 'EMPLOYEE' });
    prisma.inquiry.updateMany
      .mockResolvedValueOnce({ count: 1 }) // first request wins the atomic update
      .mockResolvedValueOnce({ count: 0 }); // second request loses it

    const [first, second] = await Promise.allSettled([
      service.submit('inq-1', actor),
      service.submit('inq-1', actor),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.reason).toBeInstanceOf(InquiryAlreadySubmittedException);
    }
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INQUIRY_SUBMITTED' }),
    );
  });
});
