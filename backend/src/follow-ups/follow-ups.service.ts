import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FollowUpNotFoundException,
  ForbiddenRoleException,
  InquiryNotFoundException,
} from '../common/exceptions/app.exception';
import { ApplicationRoleValue } from '../common/types/domain-enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateFollowUpDto } from './dto/create-follow-up.dto';
import { ListTodayFollowUpsQueryDto } from './dto/list-today-follow-ups-query.dto';
import { UpdateFollowUpDto } from './dto/update-follow-up.dto';
import {
  PublicFollowUp,
  PublicFollowUpWithInquiry,
  toPublicFollowUp,
  toPublicFollowUpWithInquiry,
} from './follow-up.mapper';
import { getTodayRangeUtc } from './today-range.util';

interface Actor {
  userId: string;
  /**
   * Optional (Phase 23A) — only create()/update() read this, for the
   * ownership check. list()/delete() don't need it: list() has no
   * ownership restriction, and delete()'s authorization is explicitly
   * unchanged from Phase 22B (ADMIN and EMPLOYEE both allowed,
   * unconditionally) — so their callers are not required to supply it.
   */
  role?: ApplicationRoleValue;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Follow-up management (Phase 16A; delete added Phase 22B; create/edit
 * ownership restriction added Phase 23A). A follow-up always belongs to
 * exactly one inquiry — created/listed/deleted via the nested
 * /inquiries/{inquiryId}/follow-ups routes. No dedicated "complete"
 * endpoint: update() with { status: 'COMPLETED' } is sufficient (see
 * UpdateFollowUpDto's doc comment).
 *
 * Authorization: create()/update() now require ADMIN, or an EMPLOYEE for
 * whom the parent inquiry's live assignedToUserId matches the actor —
 * see assertCanModifyParentInquiry()'s doc comment. list() and delete()
 * remain deliberately unrestricted beyond the base ADMIN/EMPLOYEE role
 * check (Phase 22B's delete() behavior is explicitly unchanged by
 * Phase 23A).
 */
@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(inquiryId: string, dto: CreateFollowUpDto, actor: Actor): Promise<PublicFollowUp> {
    const inquiry = await this.assertInquiryExists(inquiryId);
    this.assertCanModifyParentInquiry(inquiry, actor);

    const created = await this.prisma.followUp.create({
      data: {
        inquiryId,
        scheduledAt: new Date(dto.scheduledAt),
        status: dto.status ?? undefined,
        notes: dto.notes ?? null,
        reminderEnabled: dto.reminderEnabled ?? undefined,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'FOLLOW_UP',
      entityId: created.id,
      action: 'FOLLOW_UP_CREATED',
      newValues: { inquiryId, ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicFollowUp(created);
  }

  /**
   * DELETE /inquiries/{inquiryId}/follow-ups/{followUpId} (Phase 22B).
   * Hard delete — no existing project-wide convention calls for a soft
   * delete anywhere (Inquiries/Customers/Properties are all hard-deleted
   * too), so none is introduced here either.
   *
   * Inquiry existence and the follow-up/inquiry relationship are both
   * validated before any write: assertInquiryExists() reports a clean
   * InquiryNotFoundException when the inquiry itself doesn't exist;
   * the id+inquiryId-scoped findFirst below then reports the identical
   * FollowUpNotFoundException whether the follow-up truly doesn't exist
   * or exists under a *different* inquiry — same defensive scoping as
   * update() above, so a followUpId can never be acted on just by
   * knowing its UUID, without also knowing (and matching) its real
   * inquiryId.
   *
   * Transaction safety: AuditService.record() is never called inside a
   * Prisma $transaction anywhere in this codebase (every other delete()
   * — Inquiries/Customers/Properties — records its audit event as a
   * separate, sequential write after the row delete, not atomically).
   * This delete's requirement is stricter — a follow-up must never be
   * removed without its audit trail, and an audit trail must never claim
   * a deletion that didn't happen — so both writes are issued through the
   * same $transaction's client here, using the identical audit_logs field
   * shape AuditService.record() would have produced, rather than going
   * through that (non-transaction-aware) helper for this one call site.
   */
  async delete(inquiryId: string, followUpId: string, actor: Actor): Promise<void> {
    await this.assertInquiryExists(inquiryId);

    const existing = await this.prisma.followUp.findFirst({
      where: { id: followUpId, inquiryId },
    });
    if (!existing) {
      throw new FollowUpNotFoundException();
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          entityType: 'FOLLOW_UP',
          entityId: existing.id,
          action: 'FOLLOW_UP_DELETED',
          oldValues: {
            id: existing.id,
            inquiryId: existing.inquiryId,
            scheduledAt: existing.scheduledAt,
            status: existing.status,
            notes: existing.notes,
            reminderEnabled: existing.reminderEnabled,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        },
      });

      await tx.followUp.delete({ where: { id: followUpId } });
    });
  }

  /** Chronological — matches the Inquiry Details screen's Follow-ups section. */
  async list(inquiryId: string): Promise<PublicFollowUp[]> {
    await this.assertInquiryExists(inquiryId);

    const rows = await this.prisma.followUp.findMany({
      where: { inquiryId },
      orderBy: { scheduledAt: 'asc' },
    });

    return rows.map(toPublicFollowUp);
  }

  async update(
    inquiryId: string,
    followUpId: string,
    dto: UpdateFollowUpDto,
    actor: Actor,
  ): Promise<PublicFollowUp> {
    // Scoped by both ids together — a followUpId from a different inquiry
    // must not be editable just by knowing its UUID. The parent inquiry's
    // assignedToUserId is fetched in the same query (Phase 23A) — a
    // matching follow-up row structurally guarantees its inquiry exists
    // (FK), so no separate existence check is needed here, only its
    // current assignment, for the ownership rule below.
    const existing = await this.prisma.followUp.findFirst({
      where: { id: followUpId, inquiryId },
      include: { inquiry: { select: { assignedToUserId: true } } },
    });
    if (!existing) {
      throw new FollowUpNotFoundException();
    }

    this.assertCanModifyParentInquiry(existing.inquiry, actor);

    const oldValues = {
      scheduledAt: existing.scheduledAt,
      status: existing.status,
      notes: existing.notes,
      reminderEnabled: existing.reminderEnabled,
    };

    const updated = await this.prisma.followUp.update({
      where: { id: followUpId },
      data: {
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        status: dto.status ?? undefined,
        notes: dto.notes ?? undefined,
        reminderEnabled: dto.reminderEnabled ?? undefined,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'FOLLOW_UP',
      entityId: followUpId,
      action: 'FOLLOW_UP_UPDATED',
      oldValues,
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicFollowUp(updated);
  }

  /**
   * GET /follow-ups/today (Phase 16A Part 6) — the dashboard's Today's
   * Follow-ups section. "Today" per getTodayRangeUtc's documented IST
   * assumption, not process-local time or string comparison.
   *
   * A single query with a `select`-scoped `include` for the parent
   * inquiry + its customer (id/name only) — not N+1: one query
   * regardless of how many follow-ups match, same pattern as
   * InquiriesService.list()'s handledBy/assignedTo (Phase 14A). No
   * pagination: "today" is a naturally small, bounded set for any single
   * business, unlike the paginated inquiry/customer/property lists.
   *
   * Lightweight inquiries (customer=null) are handled safely — `customer`
   * is nullable throughout the mapper chain, never assumed present.
   */
  async listToday(query: ListTodayFollowUpsQueryDto): Promise<PublicFollowUpWithInquiry[]> {
    const { start, end } = getTodayRangeUtc();

    const rows = await this.prisma.followUp.findMany({
      where: {
        scheduledAt: { gte: start, lt: end },
        status: query.status ?? undefined,
      },
      orderBy: { scheduledAt: 'asc' },
      include: {
        inquiry: {
          select: {
            id: true,
            inquiryNumber: true,
            status: true,
            customer: { select: { id: true, name: true } },
          },
        },
      },
    });

    return rows.map(toPublicFollowUpWithInquiry);
  }

  /**
   * Returns just assignedToUserId (Phase 23A) rather than void — create()
   * needs it for the ownership check immediately after; list()/delete()
   * simply don't use the return value, so this is a safe, non-breaking
   * narrowing (select-scoped instead of a full-row fetch) rather than a
   * new query for any existing caller.
   */
  private async assertInquiryExists(
    inquiryId: string,
  ): Promise<{ assignedToUserId: string | null }> {
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id: inquiryId },
      select: { assignedToUserId: true },
    });
    if (!inquiry) {
      throw new InquiryNotFoundException();
    }
    return inquiry;
  }

  /**
   * Phase 23A — mirrors InquiriesService's assertCanModifyInquiry() rule
   * exactly (ADMIN: any inquiry; EMPLOYEE: only when the parent inquiry's
   * live assignedToUserId equals the actor — never assignment history,
   * never who created/last-edited the follow-up itself), applied here to
   * the follow-up's *parent inquiry* rather than the follow-up row, since
   * a follow-up has no assignment of its own — its permission is always
   * derived from its inquiry's current assignment. Not literally shared
   * code with InquiriesService: no cross-service/module authorization
   * helper exists anywhere in this codebase, so none is introduced here
   * either — each service keeps its own small private assert*() helpers,
   * matching this file's own pre-existing style (see assertInquiryExists
   * above).
   *
   * Deliberately NOT used by list() (no ownership restriction on reading)
   * or delete() (Phase 22B's unrestricted ADMIN+EMPLOYEE delete behavior
   * is explicitly unchanged by this phase).
   */
  private assertCanModifyParentInquiry(
    inquiry: { assignedToUserId: string | null },
    actor: Actor,
  ): void {
    if (actor.role === 'EMPLOYEE' && inquiry.assignedToUserId !== actor.userId) {
      throw new ForbiddenRoleException(
        'You can only create or edit follow-ups for inquiries currently assigned to you.',
      );
    }
  }
}
