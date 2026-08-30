import { Test, TestingModule } from '@nestjs/testing';
import { NotificationNotFoundException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService (critical paths)', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  const baseRow = {
    id: 'notif-1',
    userId: 'employee-1',
    type: 'INQUIRY_ASSIGNED',
    title: 'New inquiry assigned',
    message: 'You have been assigned inquiry INQ-1.',
    entityType: 'INQUIRY',
    entityId: 'inq-1',
    isRead: false,
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(NotificationsService);
  });

  it('creates a notification for the given recipient', async () => {
    prisma.notification.create.mockResolvedValue(baseRow);

    const result = await service.create({
      userId: 'employee-1',
      type: 'INQUIRY_ASSIGNED',
      title: 'New inquiry assigned',
      message: 'You have been assigned inquiry INQ-1.',
      entityType: 'INQUIRY',
      entityId: 'inq-1',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'employee-1', type: 'INQUIRY_ASSIGNED' }),
      }),
    );
    expect(result.id).toBe('notif-1');
  });

  it('scopes list() to the requesting user only', async () => {
    prisma.notification.findMany.mockResolvedValue([baseRow]);
    prisma.notification.count.mockResolvedValue(1);

    await service.list('employee-1', {});

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'employee-1' } }),
    );
  });

  it('applies the isRead filter when provided', async () => {
    await service.list('employee-1', { isRead: false });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'employee-1', isRead: false } }),
    );
  });

  it('marks a notification read and stamps readAt', async () => {
    prisma.notification.findFirst.mockResolvedValue({ ...baseRow, isRead: false, readAt: null });
    prisma.notification.update.mockResolvedValue({
      ...baseRow,
      isRead: true,
      readAt: new Date('2026-01-02T00:00:00Z'),
    });

    await service.update('employee-1', 'notif-1', { isRead: true });

    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: 'notif-1', userId: 'employee-1' },
    });
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isRead: true, readAt: expect.any(Date) }),
      }),
    );
  });

  it('marking an already-read notification read again does not change readAt', async () => {
    const firstReadAt = new Date('2026-01-02T00:00:00Z');
    prisma.notification.findFirst.mockResolvedValue({
      ...baseRow,
      isRead: true,
      readAt: firstReadAt,
    });
    prisma.notification.update.mockResolvedValue({ ...baseRow, isRead: true, readAt: firstReadAt });

    await service.update('employee-1', 'notif-1', { isRead: true });

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ readAt: firstReadAt }) }),
    );
  });

  it('unmarking a notification (isRead: false) clears readAt', async () => {
    prisma.notification.findFirst.mockResolvedValue({
      ...baseRow,
      isRead: true,
      readAt: new Date('2026-01-02T00:00:00Z'),
    });
    prisma.notification.update.mockResolvedValue({ ...baseRow, isRead: false, readAt: null });

    await service.update('employee-1', 'notif-1', { isRead: false });

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isRead: false, readAt: null }) }),
    );
  });

  it('rejects marking a notification that does not belong to the caller (404, not leaked)', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(
      service.update('someone-else', 'notif-1', { isRead: true }),
    ).rejects.toBeInstanceOf(NotificationNotFoundException);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });
});
