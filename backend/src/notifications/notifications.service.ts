import { Injectable } from '@nestjs/common';
import { NotificationNotFoundException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { PublicNotification, toPublicNotification } from './notification.mapper';

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

/**
 * In-app notifications (this phase). No existing notification system was
 * found anywhere in this codebase (verified by repository-wide search) —
 * this is genuinely new, modeled on the same generic
 * entityType/entityId/free-text-type shape as AuditLog, since it's the
 * same kind of system-generated event record, just recipient-scoped and
 * user-facing rather than an admin trail.
 *
 * create() is deliberately not exposed over HTTP — notifications are
 * always system-generated as a side effect of a real business action
 * (e.g. InquiriesService.assign()), never created directly by a client,
 * same as AuditService.record(). Every read/write here is scoped to the
 * calling user's own notifications; there is no "list anyone's
 * notifications" capability.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateNotificationInput): Promise<PublicNotification> {
    const created = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });

    return toPublicNotification(created);
  }

  async list(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<PaginatedResult<PublicNotification>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { userId };
    if (query.isRead !== undefined) where.isRead = query.isRead;

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: rows.map(toPublicNotification),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /**
   * Scoped by both id and userId together — a notification id from
   * another user must not be readable/markable just by knowing its UUID
   * (same defensive-scoping pattern as FollowUpsService.update()).
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateNotificationDto,
  ): Promise<PublicNotification> {
    const existing = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!existing) {
      throw new NotificationNotFoundException();
    }

    const nextIsRead = dto.isRead ?? existing.isRead;

    const updated = await this.prisma.notification.update({
      where: { id },
      data: {
        isRead: nextIsRead,
        readAt: nextIsRead ? (existing.isRead ? existing.readAt : new Date()) : null,
      },
    });

    return toPublicNotification(updated);
  }
}
