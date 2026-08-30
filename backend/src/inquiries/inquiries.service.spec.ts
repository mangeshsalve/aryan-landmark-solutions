import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import {
  InquiryAlreadySubmittedException,
  InquiryRecordingRequiredException,
} from '../common/exceptions/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
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
        { provide: NotificationsService, useValue: { create: jest.fn() } },
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

describe('InquiriesService.list (customerName)', () => {
  let service: InquiriesService;
  let prisma: {
    inquiry: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      inquiry: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: AttachmentsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();

    service = module.get(InquiriesService);
  });

  // Requirement: "Do NOT create an N+1 query solution" — the customer
  // relation must come from the same single findMany call as
  // handledBy/assignedTo, not a separate query per row or per page.
  it('fetches customer via the same single findMany include as handledBy/assignedTo (not N+1)', async () => {
    await service.list({});

    expect(prisma.inquiry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          customer: { select: { name: true } },
          handledBy: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
        }),
      }),
    );
  });

  it('returns customerName for an inquiry with a linked customer', async () => {
    prisma.inquiry.findMany.mockResolvedValue([
      {
        id: 'inq-1',
        inquiryNumber: 'INQ-001',
        customerId: 'cust-1',
        customer: { name: 'Mangesh Salve' },
        propertyId: null,
        type: null,
        priority: 'MEDIUM',
        status: 'NEW',
        externalReference: null,
        handledByUserId: null,
        handledBy: null,
        assignedToUserId: null,
        assignedTo: null,
        remarks: null,
        isPublic: false,
        city: null,
        state: null,
        pincode: null,
        locality: null,
        maxBudget: null,
        submittedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.inquiry.count.mockResolvedValue(1);

    const result = await service.list({});

    expect(result.data[0].customerId).toBe('cust-1');
    expect(result.data[0].customerName).toBe('Mangesh Salve');
  });

  it('returns customerName: null for a lightweight inquiry with no linked customer — existing list behavior otherwise unchanged', async () => {
    prisma.inquiry.findMany.mockResolvedValue([
      {
        id: 'inq-2',
        inquiryNumber: 'INQ-002',
        customerId: null,
        customer: null,
        propertyId: null,
        type: null,
        priority: 'MEDIUM',
        status: 'NEW',
        externalReference: null,
        handledByUserId: null,
        handledBy: null,
        assignedToUserId: null,
        assignedTo: null,
        remarks: null,
        isPublic: false,
        city: null,
        state: null,
        pincode: null,
        locality: null,
        maxBudget: null,
        submittedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.inquiry.count.mockResolvedValue(1);

    const result = await service.list({});

    expect(result.data[0].customerId).toBeNull();
    expect(result.data[0].customerName).toBeNull();
    // Existing fields still present/correct alongside the new one.
    expect(result.data[0].inquiryNumber).toBe('INQ-002');
    expect(result.pagination).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
  });
});
