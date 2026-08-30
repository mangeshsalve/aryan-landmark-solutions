import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import {
  FollowUpNotFoundException,
  ForbiddenRoleException,
  InquiryNotFoundException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpsService } from './follow-ups.service';

describe('FollowUpsService.delete (Phase 22B)', () => {
  let service: FollowUpsService;
  let prisma: {
    inquiry: { findUnique: jest.Mock };
    followUp: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: { auditLog: { create: jest.Mock }; followUp: { delete: jest.Mock } };
  let callOrder: string[];

  const actor = { userId: 'employee-1', ipAddress: '127.0.0.1', userAgent: 'jest' };

  const existingFollowUp = {
    id: 'followup-1',
    inquiryId: 'inq-1',
    scheduledAt: new Date('2026-08-30T10:00:00.000Z'),
    status: 'PENDING',
    notes: 'Call back after lunch',
    reminderEnabled: true,
  };

  beforeEach(async () => {
    callOrder = [];
    tx = {
      auditLog: {
        create: jest.fn().mockImplementation(async () => {
          callOrder.push('auditLog.create');
          return {};
        }),
      },
      followUp: {
        delete: jest.fn().mockImplementation(async () => {
          callOrder.push('followUp.delete');
          return existingFollowUp;
        }),
      },
    };

    prisma = {
      inquiry: { findUnique: jest.fn() },
      followUp: { findFirst: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FollowUpsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(FollowUpsService);
  });

  it('deletes the follow-up and writes an audit record identifying who/what/when, inside one transaction', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ id: 'inq-1' });
    prisma.followUp.findFirst.mockResolvedValue(existingFollowUp);

    await service.delete('inq-1', 'followup-1', actor);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'employee-1',
          entityType: 'FOLLOW_UP',
          entityId: 'followup-1',
          action: 'FOLLOW_UP_DELETED',
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
          oldValues: {
            id: 'followup-1',
            inquiryId: 'inq-1',
            scheduledAt: existingFollowUp.scheduledAt,
            status: 'PENDING',
            notes: 'Call back after lunch',
            reminderEnabled: true,
          },
        }),
      }),
    );

    expect(tx.followUp.delete).toHaveBeenCalledWith({ where: { id: 'followup-1' } });
  });

  it('records the audit log before deleting the row, inside the same transaction (never a delete with no audit trail)', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ id: 'inq-1' });
    prisma.followUp.findFirst.mockResolvedValue(existingFollowUp);

    await service.delete('inq-1', 'followup-1', actor);

    expect(callOrder).toEqual(['auditLog.create', 'followUp.delete']);
  });

  it('rejects deleting a follow-up that belongs to a different inquiry, without touching the transaction', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ id: 'inq-2' });
    // Scoped lookup (id + inquiryId together) finds nothing, exactly as it
    // would for a truly nonexistent id — the caller can't distinguish
    // "wrong inquiry" from "doesn't exist" from the error alone.
    prisma.followUp.findFirst.mockResolvedValue(null);

    await expect(service.delete('inq-2', 'followup-1', actor)).rejects.toBeInstanceOf(
      FollowUpNotFoundException,
    );

    expect(prisma.followUp.findFirst).toHaveBeenCalledWith({
      where: { id: 'followup-1', inquiryId: 'inq-2' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects deleting when the follow-up does not exist at all', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ id: 'inq-1' });
    prisma.followUp.findFirst.mockResolvedValue(null);

    await expect(service.delete('inq-1', 'nonexistent', actor)).rejects.toBeInstanceOf(
      FollowUpNotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects deleting when the inquiry itself does not exist, without ever querying for the follow-up', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(null);

    await expect(service.delete('missing-inquiry', 'followup-1', actor)).rejects.toBeInstanceOf(
      InquiryNotFoundException,
    );

    expect(prisma.followUp.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('FollowUpsService.create/update ownership (Phase 23A)', () => {
  let service: FollowUpsService;
  let prisma: {
    inquiry: { findUnique: jest.Mock };
    followUp: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };

  const adminActor = { userId: 'admin-1', role: 'ADMIN' as const };
  const assignedEmployee = { userId: 'employee-1', role: 'EMPLOYEE' as const };
  const otherEmployee = { userId: 'employee-9', role: 'EMPLOYEE' as const };

  const createDto = { scheduledAt: '2026-08-30T10:00:00.000Z' };

  const existingFollowUp = {
    id: 'followup-1',
    inquiryId: 'inq-1',
    scheduledAt: new Date('2026-08-30T10:00:00.000Z'),
    status: 'PENDING',
    notes: null,
    reminderEnabled: false,
    // Included via the same query (Phase 23A) — the parent inquiry's
    // live assignment, for the ownership check.
    inquiry: { assignedToUserId: 'employee-1' },
  };

  beforeEach(async () => {
    prisma = {
      inquiry: { findUnique: jest.fn() },
      followUp: {
        create: jest.fn().mockResolvedValue({ ...existingFollowUp, id: 'followup-new' }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue(existingFollowUp),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FollowUpsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(FollowUpsService);
  });

  describe('create()', () => {
    it('lets an ADMIN create a follow-up on any inquiry, regardless of assignment', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ assignedToUserId: 'employee-9' });

      await expect(service.create('inq-1', createDto, adminActor)).resolves.toBeDefined();
      expect(prisma.followUp.create).toHaveBeenCalled();
    });

    it('lets the currently-assigned EMPLOYEE create a follow-up on their own inquiry', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ assignedToUserId: 'employee-1' });

      await expect(service.create('inq-1', createDto, assignedEmployee)).resolves.toBeDefined();
      expect(prisma.followUp.create).toHaveBeenCalled();
    });

    it("rejects an EMPLOYEE creating a follow-up on another employee's inquiry", async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ assignedToUserId: 'employee-1' });

      await expect(service.create('inq-1', createDto, otherEmployee)).rejects.toBeInstanceOf(
        ForbiddenRoleException,
      );
      expect(prisma.followUp.create).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('lets an ADMIN edit a follow-up on any inquiry, regardless of assignment', async () => {
      prisma.followUp.findFirst.mockResolvedValue({
        ...existingFollowUp,
        inquiry: { assignedToUserId: 'employee-9' },
      });

      await expect(
        service.update('inq-1', 'followup-1', { notes: 'updated' }, adminActor),
      ).resolves.toBeDefined();
      expect(prisma.followUp.update).toHaveBeenCalled();
    });

    it('lets the currently-assigned EMPLOYEE edit a follow-up on their own inquiry', async () => {
      prisma.followUp.findFirst.mockResolvedValue(existingFollowUp); // inquiry.assignedToUserId: 'employee-1'

      await expect(
        service.update('inq-1', 'followup-1', { notes: 'updated' }, assignedEmployee),
      ).resolves.toBeDefined();
      expect(prisma.followUp.update).toHaveBeenCalled();
    });

    it('rejects an EMPLOYEE editing a follow-up whose parent inquiry belongs to another employee', async () => {
      prisma.followUp.findFirst.mockResolvedValue(existingFollowUp); // inquiry.assignedToUserId: 'employee-1'

      await expect(
        service.update('inq-1', 'followup-1', { notes: 'updated' }, otherEmployee),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);
      expect(prisma.followUp.update).not.toHaveBeenCalled();
    });

    // Reassignment: permission must follow the *current* assignedToUserId,
    // not who created/last-edited the follow-up and not historical
    // assignment — modeled here by the same followUpId now resolving with
    // a *different* parent-inquiry assignment than the earlier test.
    it('reflects a reassignment immediately: the new assignee gains, the old assignee loses, edit permission', async () => {
      // Before reassignment: inquiry is assigned to employee-1.
      prisma.followUp.findFirst.mockResolvedValueOnce({
        ...existingFollowUp,
        inquiry: { assignedToUserId: 'employee-1' },
      });
      await expect(
        service.update('inq-1', 'followup-1', { notes: 'v1' }, assignedEmployee),
      ).resolves.toBeDefined();

      // After reassignment: inquiry is now assigned to employee-9.
      // employee-1 (the old assignee) immediately loses access...
      prisma.followUp.findFirst.mockResolvedValueOnce({
        ...existingFollowUp,
        inquiry: { assignedToUserId: 'employee-9' },
      });
      await expect(
        service.update('inq-1', 'followup-1', { notes: 'v2' }, assignedEmployee),
      ).rejects.toBeInstanceOf(ForbiddenRoleException);

      // ...and employee-9 (the new assignee) immediately gains it.
      prisma.followUp.findFirst.mockResolvedValueOnce({
        ...existingFollowUp,
        inquiry: { assignedToUserId: 'employee-9' },
      });
      await expect(
        service.update('inq-1', 'followup-1', { notes: 'v3' }, otherEmployee),
      ).resolves.toBeDefined();
    });
  });
});
