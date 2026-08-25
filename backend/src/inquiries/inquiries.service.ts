import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CustomerNotFoundException,
  InquiryAlreadySubmittedException,
  InquiryAssignmentInvalidException,
  InquiryMatchingInvalidException,
  InquiryNotFoundException,
  InquiryRecordingRequiredException,
  PropertyNotFoundException,
  UserNotFoundException,
} from '../common/exceptions/app.exception';
import { ApplicationRoleValue } from '../common/types/domain-enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { toPublicAttachment } from '../attachments/attachment.mapper';
import { ListAttachmentsQueryDto } from '../attachments/dto/list-attachments-query.dto';
import { toPublicProperty } from '../properties/property.mapper';
import { toPublicAssignment, PublicAssignment } from './assignment.mapper';
import { AssignInquiryDto } from './dto/assign-inquiry.dto';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQueryDto } from './dto/list-inquiries-query.dto';
import { PublicVisibilityDto } from './dto/public-visibility.dto';
import { UpdateInquiryDto } from './dto/update-inquiry.dto';
import { generateInquiryNumber } from './inquiry-number.util';
import { PublicInquiryMatch } from './inquiry-match.mapper';
import {
  toInquiryCustomerSummary,
  toPublicInquiry,
  PublicInquiry,
  PublicInquiryDetail,
} from './inquiry.mapper';

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface Actor {
  userId: string;
  role: ApplicationRoleValue;
  ipAddress?: string;
  userAgent?: string;
}

const MAX_INQUIRY_NUMBER_ATTEMPTS = 5;

/**
 * Inquiry Management (Phases 6-7). Connects a customer (users.userType=
 * CUSTOMER) with a property, tracks the ADMIN/EMPLOYEE handling and
 * assignment of the deal, via handledByUserId/assignedToUserId — two
 * distinct concepts kept separate (see create()/update()), with every
 * assignedToUserId change appended to inquiry_assignments (history is
 * append-only; nothing is ever deleted from it). Call recordings are
 * ordinary `attachments` rows (attachmentType=RECORDING) — this service
 * never touches R2 or attachment metadata directly, it only asks
 * AttachmentsService whether a qualifying recording exists.
 *
 * Submission lifecycle: `inquiries.submitted_at` is NULL until
 * submit() sets it. A RECORDING attachment's `inquiry_id` must reference
 * an inquiry that already exists (chk_attachment_relationship, and
 * AttachmentsService's own validateRelationshipAndResource, both require
 * this), so a recording can never be attached *before* the inquiry row
 * it belongs to is created — which is exactly why the ADMIN-mandatory-
 * recording rule is checked at submit() (a separate, later step) rather
 * than at create() (which always succeeds regardless of role). See
 * submit()'s own doc comment for the full rule.
 */
@Injectable()
export class InquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  async list(query: ListInquiriesQueryDto): Promise<PaginatedResult<PublicInquiry>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.assignedToUserId) where.assignedToUserId = query.assignedToUserId;
    if (query.handledByUserId) where.handledByUserId = query.handledByUserId;
    if (query.customerId) where.customerId = query.customerId;
    if (query.propertyId) where.propertyId = query.propertyId;

    const [rows, total] = await Promise.all([
      this.prisma.inquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inquiry.count({ where }),
    ]);

    return {
      data: rows.map(toPublicInquiry),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getById(id: string): Promise<PublicInquiryDetail> {
    const inquiry = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!inquiry) {
      throw new InquiryNotFoundException();
    }
    return this.toDetail(inquiry);
  }

  async create(dto: CreateInquiryDto, actor: Actor): Promise<PublicInquiryDetail> {
    await this.assertCustomer(dto.customerId);
    await this.assertProperty(dto.propertyId);
    if (dto.handledByUserId) {
      await this.assertApplicationUser(dto.handledByUserId);
    }
    if (dto.assignedToUserId) {
      await this.assertAssignableUser(dto.assignedToUserId);
    }

    // An EMPLOYEE creating an inquiry defaults to handling/self-assigning
    // it when the request doesn't name someone else — no default for
    // ADMIN (who must name an employee explicitly, or leave both unset).
    // No extra validation needed for the self-default: the actor is
    // already a verified, currently-authenticated APPLICATION_USER via
    // the JWT guard.
    const handledByUserId =
      dto.handledByUserId ?? (actor.role === 'EMPLOYEE' ? actor.userId : null);
    const assignedToUserId =
      dto.assignedToUserId ?? (actor.role === 'EMPLOYEE' ? actor.userId : null);

    const inquiryNumber = await this.resolveInquiryNumber();

    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const inquiry = await tx.inquiry.create({
        data: {
          inquiryNumber,
          customerId: dto.customerId,
          propertyId: dto.propertyId,
          type: dto.type ?? null,
          priority: dto.priority ?? undefined,
          externalReference: dto.externalReference ?? null,
          handledByUserId,
          assignedToUserId,
          remarks: dto.remarks ?? null,
          preferredCity: dto.preferredCity ?? null,
          preferredPincode: dto.preferredPincode ?? null,
          maxBudget: dto.maxBudget ?? null,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
        },
      });

      // The ADMIN-mandatory-recording rule is enforced entirely at
      // submit() (submittedAt), not here — a RECORDING attachment can
      // only be created once this row already exists, so creation always
      // succeeds regardless of role. See submit()'s doc comment.

      if (assignedToUserId) {
        await tx.inquiryAssignment.create({
          data: {
            inquiryId: inquiry.id,
            assignedFromUserId: null,
            assignedToUserId,
            createdByUserId: actor.userId,
          },
        });
      }

      return inquiry;
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: created.id,
      action: 'INQUIRY_CREATED',
      newValues: { ...dto, inquiryNumber, handledByUserId, assignedToUserId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.toDetail(created);
  }

  async update(id: string, dto: UpdateInquiryDto, actor: Actor): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    if (dto.customerId && dto.customerId !== existing.customerId) {
      await this.assertCustomer(dto.customerId);
    }
    if (dto.propertyId && dto.propertyId !== existing.propertyId) {
      await this.assertProperty(dto.propertyId);
    }
    if (dto.handledByUserId && dto.handledByUserId !== existing.handledByUserId) {
      await this.assertApplicationUser(dto.handledByUserId);
    }

    const isReassigning =
      dto.assignedToUserId !== undefined && dto.assignedToUserId !== existing.assignedToUserId;
    if (isReassigning) {
      await this.assertAssignableUser(dto.assignedToUserId as string);
    }

    const oldValues = {
      customerId: existing.customerId,
      propertyId: existing.propertyId,
      type: existing.type,
      priority: existing.priority,
      status: existing.status,
      externalReference: existing.externalReference,
      handledByUserId: existing.handledByUserId,
      assignedToUserId: existing.assignedToUserId,
      remarks: existing.remarks,
      preferredCity: existing.preferredCity,
      preferredPincode: existing.preferredPincode,
      maxBudget: existing.maxBudget,
    };

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const result = await tx.inquiry.update({
        where: { id },
        data: {
          customerId: dto.customerId ?? undefined,
          propertyId: dto.propertyId ?? undefined,
          type: dto.type ?? undefined,
          priority: dto.priority ?? undefined,
          status: dto.status ?? undefined,
          externalReference: dto.externalReference ?? undefined,
          handledByUserId: dto.handledByUserId ?? undefined,
          assignedToUserId: isReassigning ? dto.assignedToUserId : undefined,
          remarks: dto.remarks ?? undefined,
          preferredCity: dto.preferredCity ?? undefined,
          preferredPincode: dto.preferredPincode ?? undefined,
          maxBudget: dto.maxBudget ?? undefined,
          updatedByUserId: actor.userId,
        },
      });

      if (isReassigning) {
        await tx.inquiryAssignment.create({
          data: {
            inquiryId: id,
            assignedFromUserId: existing.assignedToUserId ?? null,
            assignedToUserId: dto.assignedToUserId as string,
            createdByUserId: actor.userId,
          },
        });
      }

      return result;
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'INQUIRY_UPDATED',
      oldValues,
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.toDetail(updated);
  }

  /**
   * Submission — the one place the ADMIN-mandatory-recording rule is
   * enforced (see class-level doc comment for why it can't be enforced
   * at create() instead). The recording check reuses AttachmentsService
   * (no R2/attachment logic duplicated here); it runs before the write
   * since the recording, if any, was already committed by an earlier,
   * separate request and isn't affected by this one.
   *
   * Concurrency (Phase 9B fix): the actual double-submit guard is the
   * `updateMany({ where: { id, submittedAt: null }, ... })` below, not
   * the `existing`/`existing.submittedAt` reads above those reads are
   * only there to produce an accurate, fast error message in the common
   * (non-racing) case. A plain SELECT-then-UPDATE (the previous
   * implementation) does NOT close the race under Postgres's default
   * READ COMMITTED isolation: two concurrent requests can both read
   * submittedAt=NULL before either commits, and an UPDATE keyed only on
   * `id` would let both succeed. Filtering the UPDATE itself on
   * `submittedAt: null` makes the database's own row-level locking do
   * the job — only one concurrent UPDATE can ever match that WHERE
   * clause and return count=1; every other concurrent caller gets
   * count=0 and a clean error, and the audit event below only ever runs
   * on the branch that actually got count=1.
   *
   * The recording requirement is based on the inquiry's *creator's*
   * role (existing.createdByUserId → users.role), never the role of
   * whoever is calling this endpoint — an EMPLOYEE may submit an
   * ADMIN-created inquiry and the ADMIN requirement still applies, and
   * vice versa.
   */
  async submit(id: string, actor: Actor): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }
    if (existing.submittedAt) {
      throw new InquiryAlreadySubmittedException();
    }

    const creator = await this.prisma.user.findUnique({
      where: { id: existing.createdByUserId },
    });
    if (creator?.role === 'ADMIN') {
      const recordings = await this.attachmentsService.list({
        inquiryId: id,
        attachmentType: 'RECORDING',
      } as ListAttachmentsQueryDto);
      if (recordings.length === 0) {
        throw new InquiryRecordingRequiredException(
          'This inquiry was created by an ADMIN; at least one RECORDING attachment is required before it can be submitted.',
        );
      }
    }

    const submittedAt = new Date();

    // Atomic conditional update — see doc comment above. This single
    // statement is what actually prevents a double-submit; it needs no
    // surrounding $transaction since it's already one atomic operation.
    const { count } = await this.prisma.inquiry.updateMany({
      where: { id, submittedAt: null },
      data: { submittedAt, updatedByUserId: actor.userId },
    });

    if (count === 0) {
      // Lost the race (or the row vanished between the reads above and
      // here) — re-check to report the accurate error rather than
      // assuming which one it was.
      const current = await this.prisma.inquiry.findUnique({ where: { id } });
      if (!current) {
        throw new InquiryNotFoundException();
      }
      throw new InquiryAlreadySubmittedException();
    }

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'INQUIRY_SUBMITTED',
      oldValues: { submittedAt: null },
      newValues: { submittedAt },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.getById(id);
  }

  async assign(id: string, dto: AssignInquiryDto, actor: Actor): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    await this.assertAssignableUser(dto.assignedToUserId);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.inquiry.update({
        where: { id },
        data: { assignedToUserId: dto.assignedToUserId, updatedByUserId: actor.userId },
      });

      await tx.inquiryAssignment.create({
        data: {
          inquiryId: id,
          assignedFromUserId: existing.assignedToUserId ?? null,
          assignedToUserId: dto.assignedToUserId,
          reason: dto.reason ?? null,
          createdByUserId: actor.userId,
        },
      });
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'INQUIRY_ASSIGNED',
      oldValues: { assignedToUserId: existing.assignedToUserId },
      newValues: { assignedToUserId: dto.assignedToUserId, reason: dto.reason ?? null },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.getById(id);
  }

  /**
   * GET /inquiries/{id}/matches (Phase 11) — Seller → Buyer matching only
   * (see Phase 11 report Part 8; reverse Buyer → Seller matching was not
   * requested and is not implemented).
   *
   * Weights: location 50, pincode 30, budget 20 (max 100); only scores
   * >= 70 are returned, sorted highest first. Because 30+20=50 < 70,
   * reaching the threshold structurally requires the location criterion
   * to match — every returned match has already matched on city. This
   * is a mathematical consequence of the given weights, not an extra
   * invented rule, and is exploited below as a genuine (not speculative)
   * query optimization: candidates are pre-filtered to the seller
   * property's city at the database level via the new idx_inquiries_type
   * index, rather than loading every BUYER inquiry into memory.
   *
   * Criteria (each binary — full points or none, no partial credit):
   *  - location (50): candidate.preferredCity equals property.city
   *    (case-insensitive)
   *  - pincode  (30): candidate.preferredPincode equals property.pincode
   *    (exact string match; no geographic distance, no address parsing)
   *  - budget   (20): property.price <= candidate.maxBudget (both sides
   *    assumed to be the same currency/unit — every property in this
   *    project uses priceUnit=INR; no conversion is implemented). Missing
   *    data on either side scores 0, never assumed to match.
   */
  async findMatches(id: string): Promise<PublicInquiryMatch[]> {
    const sellerInquiry = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!sellerInquiry) {
      throw new InquiryNotFoundException();
    }
    if (sellerInquiry.type !== 'SELLER') {
      throw new InquiryMatchingInvalidException(
        'Matching is only available for inquiries with type=SELLER.',
      );
    }
    if (!sellerInquiry.propertyId) {
      throw new InquiryMatchingInvalidException(
        'This inquiry has no associated property to match against.',
      );
    }

    const property = await this.prisma.property.findUnique({
      where: { id: sellerInquiry.propertyId },
    });
    if (!property) {
      throw new PropertyNotFoundException();
    }

    // No city on the property means no candidate can ever reach the
    // mandatory location score — short-circuit rather than loading and
    // scoring a candidate set that can only ever produce zero results.
    if (!property.city) {
      return [];
    }

    const candidates = await this.prisma.inquiry.findMany({
      where: {
        type: 'BUYER',
        preferredCity: { equals: property.city, mode: 'insensitive' },
      },
      include: { customer: true },
    });

    const propertyPrice = property.price === null ? null : Number(property.price);

    const matches: PublicInquiryMatch[] = [];
    for (const candidate of candidates) {
      const locationScore = 50; // guaranteed by the preferredCity filter above

      const pincodeScore =
        candidate.preferredPincode !== null &&
        property.pincode !== null &&
        candidate.preferredPincode === property.pincode
          ? 30
          : 0;

      const candidateMaxBudget = candidate.maxBudget === null ? null : Number(candidate.maxBudget);
      const budgetScore =
        candidateMaxBudget !== null && propertyPrice !== null && propertyPrice <= candidateMaxBudget
          ? 20
          : 0;

      const matchingScore = locationScore + pincodeScore + budgetScore;
      if (matchingScore < 70) {
        continue;
      }

      matches.push({
        inquiryId: candidate.id,
        customerId: candidate.customerId,
        customerName: candidate.customer.name,
        customerMobile: candidate.customer.mobile,
        preferredCity: candidate.preferredCity,
        preferredPincode: candidate.preferredPincode,
        maxBudget: candidateMaxBudget,
        matchingScore,
      });
    }

    matches.sort((a, b) => b.matchingScore - a.matchingScore);
    return matches;
  }

  async listAssignments(id: string): Promise<PublicAssignment[]> {
    const exists = await this.prisma.inquiry.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      throw new InquiryNotFoundException();
    }

    const rows = await this.prisma.inquiryAssignment.findMany({
      where: { inquiryId: id },
      orderBy: { assignedAt: 'desc' },
    });

    return rows.map(toPublicAssignment);
  }

  async setPublicVisibility(
    id: string,
    dto: PublicVisibilityDto,
    actor: Actor,
  ): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    const updated = await this.prisma.inquiry.update({
      where: { id },
      data: { isPublic: dto.isPublic, updatedByUserId: actor.userId },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'PUBLIC_STATUS_CHANGED',
      oldValues: { isPublic: existing.isPublic },
      newValues: { isPublic: dto.isPublic },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return this.toDetail(updated);
  }

  private async toDetail(inquiry: {
    id: string;
    inquiryNumber: string;
    customerId: string;
    propertyId: string | null;
    type: string | null;
    priority: string;
    status: string;
    externalReference: string | null;
    handledByUserId: string | null;
    assignedToUserId: string | null;
    remarks: string | null;
    isPublic: boolean;
    preferredCity: string | null;
    preferredPincode: string | null;
    maxBudget: unknown;
    submittedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<PublicInquiryDetail> {
    const [customer, property, attachments] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: inquiry.customerId } }),
      inquiry.propertyId
        ? this.prisma.property.findUnique({ where: { id: inquiry.propertyId } })
        : Promise.resolve(null),
      this.prisma.attachment.findMany({
        where: { inquiryId: inquiry.id },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    return {
      ...toPublicInquiry(inquiry),
      customer: customer ? toInquiryCustomerSummary(customer) : undefined,
      property: property ? toPublicProperty(property) : null,
      attachments: attachments.map(toPublicAttachment),
    };
  }

  private async assertCustomer(customerId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: customerId } });
    if (!user || user.userType !== 'CUSTOMER') {
      throw new CustomerNotFoundException();
    }
  }

  private async assertProperty(propertyId: string): Promise<void> {
    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new PropertyNotFoundException();
    }
  }

  private async assertApplicationUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.userType !== 'APPLICATION_USER') {
      throw new UserNotFoundException(
        'handledByUserId must reference an existing APPLICATION_USER.',
      );
    }
  }

  private async assertAssignableUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new InquiryAssignmentInvalidException(
        'assignedToUserId does not reference an existing user.',
      );
    }
    if (user.userType !== 'APPLICATION_USER') {
      throw new InquiryAssignmentInvalidException(
        `assignedToUserId must reference an APPLICATION_USER; found userType ${user.userType}.`,
      );
    }
    // Same ACTIVE-only rule already applied at login (ApplicationAuthService/
    // MasterAuthService) — an INACTIVE/BLOCKED application user can't
    // authenticate, so they shouldn't be assignable either.
    if (user.status !== 'ACTIVE') {
      throw new InquiryAssignmentInvalidException(
        `assignedToUserId must reference an ACTIVE user; found status ${user.status}.`,
      );
    }
  }

  /**
   * Same placeholder-with-retry pattern as PropertiesService's property
   * code generation — see inquiry-number.util.ts.
   */
  private async resolveInquiryNumber(): Promise<string> {
    for (let attempt = 0; attempt < MAX_INQUIRY_NUMBER_ATTEMPTS; attempt++) {
      const candidate = generateInquiryNumber();
      const existing = await this.prisma.inquiry.findUnique({
        where: { inquiryNumber: candidate },
      });
      if (!existing) {
        return candidate;
      }
    }
    throw new Error('Failed to generate a unique inquiry number after several attempts.');
  }
}
