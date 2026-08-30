import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import {
  ForbiddenRoleException,
  InquiryAssignmentInvalidException,
  UserNotFoundException,
} from '../common/exceptions/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService assignment (critical paths)', () => {
  let service: InquiriesService;
  let prisma: {
    inquiry: { findUnique: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock };
    attachment: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let notifications: { create: jest.Mock };
  let tx: { inquiry: { update: jest.Mock }; inquiryAssignment: { create: jest.Mock } };

  const adminActor = { userId: 'admin-1', role: 'ADMIN' as const };
  const employeeActor = { userId: 'employee-1', role: 'EMPLOYEE' as const };

  const existingInquiry = {
    id: 'inq-1',
    inquiryNumber: 'INQ-1',
    customerId: 'cust-1',
    propertyId: null,
    assignedToUserId: 'employee-1',
    handledByUserId: 'employee-1',
    submittedAt: null,
  };

  beforeEach(async () => {
    tx = {
      inquiry: { update: jest.fn().mockResolvedValue(existingInquiry) },
      inquiryAssignment: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      inquiry: { findUnique: jest.fn(), update: jest.fn() },
      user: { findUnique: jest.fn() },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: AttachmentsService, useValue: { list: jest.fn() } },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(InquiriesService);
    prisma.inquiry.findUnique.mockResolvedValue(existingInquiry);
  });

  it('lets an ADMIN assign an inquiry to a valid APPLICATION_USER, transactionally with history', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'ACTIVE' });

    await service.assign('inq-1', { assignedToUserId: 'employee-2' }, adminActor);

    expect(tx.inquiry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignedToUserId: 'employee-2' }),
      }),
    );
    expect(tx.inquiryAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedFromUserId: 'employee-1',
          assignedToUserId: 'employee-2',
          createdByUserId: 'admin-1',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INQUIRY_ASSIGNED' }),
    );
  });

  // Phase (notifications): the literal requirement is "application
  // notification when admin assigns inquiry to employee" — gated
  // strictly on actor.role, not on who the recipient is.
  it('creates an in-app notification for the newly assigned employee when an ADMIN assigns', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'ACTIVE' });

    await service.assign('inq-1', { assignedToUserId: 'employee-2' }, adminActor);

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'employee-2',
        type: 'INQUIRY_ASSIGNED',
        entityType: 'INQUIRY',
        entityId: 'inq-1',
      }),
    );
  });

  it('lets an EMPLOYEE assign an inquiry to himself', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'ACTIVE' });

    await service.assign('inq-1', { assignedToUserId: 'employee-1' }, employeeActor);

    expect(tx.inquiryAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdByUserId: 'employee-1' }) }),
    );
  });

  it('does NOT create a notification when an EMPLOYEE assigns/reassigns (not blocked, just no notification)', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'ACTIVE' });

    await service.assign('inq-1', { assignedToUserId: 'employee-2' }, employeeActor);

    expect(tx.inquiryAssignment.create).toHaveBeenCalled(); // the assignment itself still succeeds
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('rejects assigning to a CUSTOMER', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'CUSTOMER', status: 'ACTIVE' });

    await expect(
      service.assign('inq-1', { assignedToUserId: 'cust-2' }, adminActor),
    ).rejects.toBeInstanceOf(InquiryAssignmentInvalidException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects assigning to a MASTER', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'MASTER', status: 'ACTIVE' });

    await expect(
      service.assign('inq-1', { assignedToUserId: 'master-1' }, adminActor),
    ).rejects.toBeInstanceOf(InquiryAssignmentInvalidException);
  });

  it('rejects assigning to a BLOCKED application user', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'BLOCKED' });

    await expect(
      service.assign('inq-1', { assignedToUserId: 'employee-3' }, adminActor),
    ).rejects.toBeInstanceOf(InquiryAssignmentInvalidException);
  });

  it('rejects a handledByUserId that is not an APPLICATION_USER on update', async () => {
    prisma.user.findUnique.mockResolvedValue({ userType: 'CUSTOMER' });

    await expect(
      service.update('inq-1', { handledByUserId: 'cust-9' }, adminActor),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });

  it('does not overwrite omitted fields with null on update (partial-update semantics)', async () => {
    // update() always writes through the transaction's tx client, even
    // when nothing is being reassigned.
    tx.inquiry.update = jest.fn().mockResolvedValue(existingInquiry);

    await service.update('inq-1', { remarks: 'Called back' }, adminActor);

    const call = tx.inquiry.update.mock.calls[0][0];
    expect(call.data.customerId).toBeUndefined();
    expect(call.data.propertyId).toBeUndefined();
    expect(call.data.handledByUserId).toBeUndefined();
    expect(call.data.assignedToUserId).toBeUndefined();
    expect(call.data.remarks).toBe('Called back');
    // submittedAt is never part of the update data object at all —
    // UpdateInquiryDto doesn't declare it, so there's nothing to assert
    // it against here; see dto/submitted-at-immutable.spec.ts for the
    // request-level guarantee.
    expect(call.data.submittedAt).toBeUndefined();
  });

  // Phase 23A — assign()/reassign() ownership. existingInquiry is
  // currently assigned to 'employee-1' throughout this describe block.
  describe('assign() ownership (Phase 23A)', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ userType: 'APPLICATION_USER', status: 'ACTIVE' });
    });

    it('lets an ADMIN reassign an inquiry not currently assigned to them', async () => {
      await expect(
        service.assign('inq-1', { assignedToUserId: 'employee-2' }, adminActor),
      ).resolves.toBeDefined();
    });

    it('lets the currently-assigned EMPLOYEE reassign their own inquiry', async () => {
      // existingInquiry.assignedToUserId === employeeActor.userId ('employee-1').
      await expect(
        service.assign('inq-1', { assignedToUserId: 'employee-2' }, employeeActor),
      ).resolves.toBeDefined();
    });

    it("rejects an EMPLOYEE reassigning another employee's inquiry, with a ForbiddenRoleException", async () => {
      const otherEmployee = { userId: 'employee-9', role: 'EMPLOYEE' as const };

      await expect(
        service.assign('inq-1', { assignedToUserId: 'employee-2' }, otherEmployee),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);
      // Checked before any other work — no write, no assignable-user
      // lookup side effect beyond the initial existence read.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects an EMPLOYEE trying to take over another employee's inquiry (assign to self)", async () => {
      const otherEmployee = { userId: 'employee-9', role: 'EMPLOYEE' as const };

      await expect(
        service.assign('inq-1', { assignedToUserId: 'employee-9' }, otherEmployee),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an EMPLOYEE assigning an unassigned inquiry through this endpoint (no self-pickup carve-out)', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ ...existingInquiry, assignedToUserId: null });

      await expect(
        service.assign('inq-1', { assignedToUserId: 'employee-1' }, employeeActor),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // Phase 23A — setPublicVisibility() ownership, same rule as assign()/update().
  describe('setPublicVisibility() ownership (Phase 23A)', () => {
    beforeEach(() => {
      prisma.inquiry.update.mockResolvedValue({ ...existingInquiry, isPublic: true });
    });

    it('lets an ADMIN toggle isPublic on an inquiry not assigned to them', async () => {
      await expect(
        service.setPublicVisibility('inq-1', { isPublic: true }, adminActor),
      ).resolves.toBeDefined();
    });

    it('lets the currently-assigned EMPLOYEE toggle isPublic on their own inquiry', async () => {
      await expect(
        service.setPublicVisibility('inq-1', { isPublic: true }, employeeActor),
      ).resolves.toBeDefined();
    });

    it("rejects an EMPLOYEE toggling isPublic on another employee's inquiry", async () => {
      const otherEmployee = { userId: 'employee-9', role: 'EMPLOYEE' as const };

      await expect(
        service.setPublicVisibility('inq-1', { isPublic: true }, otherEmployee),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);
      expect(prisma.inquiry.update).not.toHaveBeenCalled();
    });
  });
});
