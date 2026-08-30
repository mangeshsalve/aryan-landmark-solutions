import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CustomerNotFoundException,
  ForbiddenRoleException,
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
import { NotificationsService } from '../notifications/notifications.service';
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
import {
  deriveSyncedLocationFromProperty,
  normalizeLocationValue,
  scoreLocationQuality,
  PropertyLocationSnapshot,
} from './location-match.util';

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

/** Prisma Decimal fields come back as Decimal.js-like objects at runtime, not plain numbers. */
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

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
    private readonly notificationsService: NotificationsService,
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
      // Phase 14A: handledBy/assignedTo display names via a single
      // relation-select per page (Prisma batches this, not one query per
      // row) — not N+1. select (not include) keeps passwordHash and
      // everything else off the wire at the query layer, not just via the
      // mapper's allow-list. customer (this phase) follows the exact same
      // pattern, for customerName in the list response — still one query
      // total, regardless of page size.
      this.prisma.inquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          handledBy: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          customer: { select: { name: true } },
        },
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
    if (dto.customerId) {
      await this.assertCustomer(dto.customerId);
    }
    let property: PropertyLocationSnapshot | null = null;
    if (dto.propertyId) {
      property = await this.assertProperty(dto.propertyId);
    }
    if (dto.handledByUserId) {
      await this.assertApplicationUser(dto.handledByUserId);
    }
    if (dto.assignedToUserId) {
      await this.assertAssignableUser(dto.assignedToUserId);
    }

    // Location sync (this phase, approved plan) — a SELLER inquiry
    // created with a property linked gets its location from that
    // property; any city/state/pincode/locality the client also sent in
    // this same request are overridden, not merged, since the property
    // is authoritative the moment it's linked. Every other case (BUYER,
    // or a still-lightweight SELLER with no property yet) uses whatever
    // the client sent directly.
    const location =
      dto.type === 'SELLER' && property
        ? deriveSyncedLocationFromProperty(property)
        : {
            city: normalizeLocationValue(dto.city),
            state: normalizeLocationValue(dto.state),
            pincode: normalizeLocationValue(dto.pincode),
            locality: normalizeLocationValue(dto.locality),
          };

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
          customerId: dto.customerId ?? null,
          propertyId: dto.propertyId ?? null,
          type: dto.type ?? null,
          priority: dto.priority ?? undefined,
          externalReference: dto.externalReference ?? null,
          handledByUserId,
          assignedToUserId,
          remarks: dto.remarks ?? null,
          city: location.city,
          state: location.state,
          pincode: location.pincode,
          locality: location.locality,
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

    if (assignedToUserId) {
      await this.notifyInquiryAssigned(actor, created.id, inquiryNumber, assignedToUserId);
    }

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: created.id,
      action: 'INQUIRY_CREATED',
      // location reflects what was actually persisted, not dto's raw
      // values — for a SELLER+property inquiry these can differ (the
      // property's location overrides whatever the client sent).
      newValues: { ...dto, inquiryNumber, handledByUserId, assignedToUserId, ...location },
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

    // Phase 18A — ADMIN can edit any inquiry; EMPLOYEE can edit only the
    // inquiry currently assigned to them. Checked first, before any other
    // validation, so an unauthorized caller can't learn anything about
    // the request's validity. See assertCanModifyInquiry()'s doc comment
    // (Phase 23A) — the same rule is now shared with assign() and
    // setPublicVisibility().
    this.assertCanModifyInquiry(existing, actor);

    if (dto.customerId && dto.customerId !== existing.customerId) {
      await this.assertCustomer(dto.customerId);
    }

    // Phase [this] — a NEW, different, non-null propertyId being linked
    // in this request (not just present-and-unchanged, and not the
    // pre-existing null-doesn't-actually-clear quirk of
    // `dto.propertyId ?? undefined` below) is what triggers a location
    // re-sync from the newly-linked property.
    const isLinkingNewProperty =
      dto.propertyId !== undefined &&
      dto.propertyId !== null &&
      dto.propertyId !== existing.propertyId;
    let newProperty: PropertyLocationSnapshot | null = null;
    if (isLinkingNewProperty) {
      newProperty = await this.assertProperty(dto.propertyId as string);
    }

    if (dto.handledByUserId && dto.handledByUserId !== existing.handledByUserId) {
      await this.assertApplicationUser(dto.handledByUserId);
    }

    const isReassigning =
      dto.assignedToUserId !== undefined && dto.assignedToUserId !== existing.assignedToUserId;
    if (isReassigning) {
      await this.assertAssignableUser(dto.assignedToUserId as string);
    }

    // Location sync (this phase, approved plan). Mirrors what actually
    // gets persisted for propertyId itself (`dto.propertyId ?? undefined`
    // below — a null doesn't clear it), so this reads the *effective*
    // resulting type/propertyId, not just the raw dto values.
    const resultingType = dto.type ?? existing.type;
    const resultingPropertyId = dto.propertyId ?? existing.propertyId;
    const sellerWithProperty = resultingType === 'SELLER' && !!resultingPropertyId;

    let locationUpdate: Partial<PropertyLocationSnapshot>;
    if (sellerWithProperty) {
      // For a SELLER with a linked property, location is always
      // server-controlled: re-synced when a *new* property is linked in
      // this request, otherwise left completely untouched — any
      // city/state/pincode/locality the client also sent are silently
      // ignored, never merged, exactly like create()'s override rule.
      locationUpdate =
        isLinkingNewProperty && newProperty ? deriveSyncedLocationFromProperty(newProperty) : {};
    } else {
      // BUYER, or a still-lightweight SELLER with no property yet:
      // directly client-editable, same partial-update semantics as every
      // other field here (omitted ⇒ untouched).
      locationUpdate = {
        city: dto.city !== undefined ? normalizeLocationValue(dto.city) : undefined,
        state: dto.state !== undefined ? normalizeLocationValue(dto.state) : undefined,
        pincode: dto.pincode !== undefined ? normalizeLocationValue(dto.pincode) : undefined,
        locality: dto.locality !== undefined ? normalizeLocationValue(dto.locality) : undefined,
      };
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
      city: existing.city,
      state: existing.state,
      pincode: existing.pincode,
      locality: existing.locality,
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
          // Phase 18A Requirement 3: reassigning forces handledByUserId to
          // the same newly-assigned user (both current fields point at
          // whoever is now assigned) — a raw dto.handledByUserId is only
          // honored when this update is NOT a reassignment, preserving the
          // pre-existing "these can independently diverge" capability
          // outside of the assignment moment itself (see class doc comment).
          handledByUserId: isReassigning
            ? dto.assignedToUserId
            : (dto.handledByUserId ?? undefined),
          assignedToUserId: isReassigning ? dto.assignedToUserId : undefined,
          remarks: dto.remarks ?? undefined,
          city: locationUpdate.city,
          state: locationUpdate.state,
          pincode: locationUpdate.pincode,
          locality: locationUpdate.locality,
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

    if (isReassigning) {
      await this.notifyInquiryAssigned(
        actor,
        id,
        existing.inquiryNumber,
        dto.assignedToUserId as string,
      );
    }

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'INQUIRY_UPDATED',
      oldValues,
      // location reflects what was actually persisted, not dto's raw
      // values — for a synced SELLER these can differ (see
      // locationUpdate above).
      newValues: { ...dto, ...locationUpdate },
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

  /**
   * Phase 23A — ADMIN can assign/reassign any inquiry; EMPLOYEE only an
   * inquiry currently assigned to them (assertCanModifyInquiry, same rule
   * as update()/setPublicVisibility()). An unassigned inquiry
   * (assignedToUserId=null) is therefore not takeable by an EMPLOYEE
   * through this endpoint either — null never equals actor.userId, so the
   * same check that blocks "someone else's inquiry" also blocks "nobody's
   * inquiry yet," consistent with update()'s pre-existing behavior for
   * unassigned inquiries (no separate carve-out exists anywhere else in
   * this codebase for that case).
   */
  async assign(id: string, dto: AssignInquiryDto, actor: Actor): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    this.assertCanModifyInquiry(existing, actor);

    await this.assertAssignableUser(dto.assignedToUserId);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.inquiry.update({
        where: { id },
        data: {
          assignedToUserId: dto.assignedToUserId,
          // Phase 18A Requirement 3: assignment/reassignment always syncs
          // handledByUserId to the same user — both current fields point
          // at whoever is now assigned.
          handledByUserId: dto.assignedToUserId,
          updatedByUserId: actor.userId,
        },
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

    await this.notifyInquiryAssigned(actor, id, existing.inquiryNumber, dto.assignedToUserId);

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
   * GET /inquiries/{id}/matches (Phase 11; bidirectional as of Phase
   * 19A; unified location fields and new algorithm this phase). SELLER
   * source → matching BUYER inquiries, or BUYER source → matching SELLER
   * inquiries — genuinely symmetric now, both directions share
   * findOppositeMatches() below, since city/state/pincode/locality live
   * directly on Inquiry for both types (no more "SELLER's location comes
   * from Property, BUYER's from Inquiry" special-casing the two old
   * near-duplicate methods needed). Budget/price stays asymmetric by
   * design (unchanged this phase) — SELLER's number always comes from
   * its linked Property.price, BUYER's from Inquiry.maxBudget directly.
   *
   * There is no area/category/propertyType field on Inquiry to compare
   * against Property.area/category/propertyType, so — despite those
   * being available on Property — they are NOT used as matching criteria
   * in either direction (unchanged from Phase 19A).
   *
   * status is deliberately not checked at all — never was. What IS
   * required: a SELLER needs propertyId (a structural precondition — no
   * property means there is no price to match against, so this is a
   * 400, not an empty result); a BUYER (or a still-lightweight SELLER
   * with no property) with no pincode yet is a plain nullable-field case
   * — findOppositeMatches() returns an empty array for that, never a
   * fabricated match, never a throw.
   *
   * See location-match.util.ts for the full scoring algorithm: pincode
   * is a mandatory exact-match gate (30 pts); city is normalized exact
   * comparison, not fuzzy (up to 50 pts); locality is token-based fuzzy
   * comparison (up to 50 pts); city and locality are combined via MAX,
   * never summed; budget is unchanged (20 pts). Achievable totals are
   * therefore 30/50/80/100 — see that file's doc comment for why the
   * unchanged 70 threshold effectively requires 80 in practice.
   */
  async findMatches(id: string): Promise<PublicInquiryMatch[]> {
    const sourceInquiry = await this.prisma.inquiry.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!sourceInquiry) {
      throw new InquiryNotFoundException();
    }

    if (sourceInquiry.type === 'SELLER') {
      if (!sourceInquiry.propertyId) {
        throw new InquiryMatchingInvalidException(
          'This inquiry has no associated property to match against.',
        );
      }
      if (!sourceInquiry.property) {
        throw new PropertyNotFoundException();
      }
      return this.findOppositeMatches(sourceInquiry, 'BUYER');
    }
    if (sourceInquiry.type === 'BUYER') {
      return this.findOppositeMatches(sourceInquiry, 'SELLER');
    }

    throw new InquiryMatchingInvalidException(
      'Matching requires the inquiry to have type=BUYER or type=SELLER.',
    );
  }

  /**
   * The shared matching engine for both directions (this phase). `id: {
   * not: id }` is an explicit self-match guard — structurally redundant
   * today (a source can never satisfy a `type: oppositeType` filter
   * matching its own type) but kept as a defense-in-depth invariant
   * rather than relying solely on that.
   */
  private async findOppositeMatches(
    sourceInquiry: {
      id: string;
      city: string | null;
      locality: string | null;
      pincode: string | null;
      maxBudget: unknown;
      property: { price: unknown } | null;
    },
    oppositeType: 'BUYER' | 'SELLER',
  ): Promise<PublicInquiryMatch[]> {
    // Pincode is the mandatory gate — a source with none can never reach
    // the threshold, so short-circuit rather than loading and scoring a
    // candidate set that can only ever produce zero results. Already
    // normalized (trimmed) at write time, so a direct DB equality filter
    // below is safe.
    if (!sourceInquiry.pincode) {
      return [];
    }

    const candidates = await this.prisma.inquiry.findMany({
      where: {
        id: { not: sourceInquiry.id },
        type: oppositeType,
        pincode: sourceInquiry.pincode,
      },
      include: oppositeType === 'SELLER' ? { customer: true, property: true } : { customer: true },
    });

    // Budget/price stays asymmetric (unchanged this phase): the SELLER
    // side's number always comes from its linked Property.price, the
    // BUYER side's always from Inquiry.maxBudget directly.
    const sourcePrice =
      oppositeType === 'BUYER' // source is SELLER, matching against BUYER candidates
        ? toNullableNumber(sourceInquiry.property?.price)
        : null;
    const sourceMaxBudget =
      oppositeType === 'SELLER' // source is BUYER, matching against SELLER candidates
        ? toNullableNumber(sourceInquiry.maxBudget)
        : null;

    const matches: PublicInquiryMatch[] = [];
    for (const candidate of candidates as Array<{
      id: string;
      customerId: string | null;
      customer: { name: string; mobile: string | null } | null;
      propertyId: string | null;
      city: string | null;
      state: string | null;
      pincode: string | null;
      locality: string | null;
      maxBudget: unknown;
      property?: { price: unknown } | null;
    }>) {
      // Defensive guard, not an expected path (see class-level note on
      // why this can't happen through the normal API) — a candidate
      // missing its customer, or (for a SELLER candidate) its property,
      // is skipped rather than assumed valid.
      if (!candidate.customerId || !candidate.customer) {
        continue;
      }
      if (oppositeType === 'SELLER' && !candidate.property) {
        continue;
      }

      const locationScore = scoreLocationQuality(sourceInquiry, candidate);

      let budgetScore = 0;
      if (oppositeType === 'BUYER') {
        const candidateBudget = toNullableNumber(candidate.maxBudget);
        budgetScore =
          sourcePrice !== null && candidateBudget !== null && sourcePrice <= candidateBudget
            ? 20
            : 0;
      } else {
        const candidatePrice = toNullableNumber(candidate.property?.price);
        budgetScore =
          sourceMaxBudget !== null && candidatePrice !== null && candidatePrice <= sourceMaxBudget
            ? 20
            : 0;
      }

      const matchingScore = 30 + locationScore + budgetScore; // 30 = pincode gate, guaranteed here
      if (matchingScore < 70) {
        continue;
      }

      matches.push({
        inquiryId: candidate.id,
        inquiryType: oppositeType,
        customerId: candidate.customerId,
        customerName: candidate.customer.name,
        customerMobile: candidate.customer.mobile,
        propertyId: candidate.propertyId,
        city: candidate.city,
        state: candidate.state,
        pincode: candidate.pincode,
        locality: candidate.locality,
        maxBudget: toNullableNumber(candidate.maxBudget),
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

    // Phase 18A Requirement 4: assignedFrom/assignedTo display names via a
    // relation select — one query regardless of history length, same
    // N+1-safe pattern as InquiriesService.list()'s handledBy/assignedTo
    // (Phase 14A). select (not include-all) keeps passwordHash and
    // everything else off the wire at the query layer.
    const rows = await this.prisma.inquiryAssignment.findMany({
      where: { inquiryId: id },
      orderBy: { assignedAt: 'desc' },
      include: {
        assignedFrom: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });

    return rows.map(toPublicAssignment);
  }

  /**
   * DELETE /inquiries/{id} (Phase 18A Part 5). ADMIN-only, enforced at
   * the controller (@Roles('ADMIN') overriding the class-level
   * @Roles('ADMIN','EMPLOYEE') — RolesGuard's getAllAndOverride already
   * supports this), not repeated here.
   *
   * Relationships inspected before writing this: attachments.inquiry_id,
   * inquiry_assignments.inquiry_id, and follow_ups.inquiry_id (Phase
   * 16A) are all ON DELETE CASCADE — so a plain `inquiry.delete()`
   * already leaves no orphaned rows in any of those three tables, and
   * follow-ups are removed from the database entirely (not just hidden),
   * which is what actually guarantees they can never appear in
   * GET /follow-ups/today afterward.
   *
   * The one thing cascade does NOT handle is the R2 objects behind each
   * attachment row — a raw cascade would silently orphan them in the
   * bucket. So attachments are removed first, one at a time, through
   * AttachmentsService.remove() (the exact same path DELETE
   * /attachments/{id} already uses) — same R2-then-row order, same
   * StorageNotConfiguredException propagation if R2 isn't configured
   * (this never reports a successful delete while objects are left
   * behind, matching AttachmentsService's own existing guarantee). Only
   * after that does the inquiry row itself get deleted, cascading the
   * now-empty attachments relation plus assignment history and
   * follow-ups.
   */
  async delete(id: string, actor: Actor): Promise<void> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    const attachments = await this.attachmentsService.list({
      inquiryId: id,
    } as ListAttachmentsQueryDto);
    for (const attachment of attachments) {
      await this.attachmentsService.remove(attachment.id, actor);
    }

    await this.prisma.inquiry.delete({ where: { id } });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'INQUIRY',
      entityId: id,
      action: 'INQUIRY_DELETED',
      oldValues: {
        inquiryNumber: existing.inquiryNumber,
        customerId: existing.customerId,
        propertyId: existing.propertyId,
        status: existing.status,
        assignedToUserId: existing.assignedToUserId,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  /**
   * Phase 23A — ADMIN can toggle isPublic on any inquiry; EMPLOYEE only
   * on an inquiry currently assigned to them (assertCanModifyInquiry,
   * same rule as update()/assign()). Previously unrestricted beyond the
   * base ADMIN/EMPLOYEE role check — see Phase 21 gap analysis finding 4.
   */
  async setPublicVisibility(
    id: string,
    dto: PublicVisibilityDto,
    actor: Actor,
  ): Promise<PublicInquiryDetail> {
    const existing = await this.prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      throw new InquiryNotFoundException();
    }

    this.assertCanModifyInquiry(existing, actor);

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
    customerId: string | null;
    propertyId: string | null;
    type: string | null;
    priority: string;
    status: string;
    externalReference: string | null;
    handledByUserId: string | null;
    assignedToUserId: string | null;
    remarks: string | null;
    isPublic: boolean;
    city: string | null;
    state: string | null;
    pincode: string | null;
    locality: string | null;
    maxBudget: unknown;
    submittedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<PublicInquiryDetail> {
    const [customer, property, attachments, handledBy, assignedTo] = await Promise.all([
      inquiry.customerId
        ? this.prisma.user.findUnique({ where: { id: inquiry.customerId } })
        : Promise.resolve(null),
      inquiry.propertyId
        ? this.prisma.property.findUnique({ where: { id: inquiry.propertyId } })
        : Promise.resolve(null),
      this.prisma.attachment.findMany({
        where: { inquiryId: inquiry.id },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      }),
      // Phase 14A — display names for handledBy/assignedTo. A single
      // detail fetch, run in parallel with the others above: not N+1
      // (this method is never called in a loop).
      inquiry.handledByUserId
        ? this.prisma.user.findUnique({
            where: { id: inquiry.handledByUserId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      inquiry.assignedToUserId
        ? this.prisma.user.findUnique({
            where: { id: inquiry.assignedToUserId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      // customer is already fetched above (for the full nested `customer`
      // detail field below) — reused here for customerName too, at no
      // extra query cost.
      ...toPublicInquiry({ ...inquiry, handledBy, assignedTo, customer }),
      customer: customer ? toInquiryCustomerSummary(customer) : undefined,
      property: property ? toPublicProperty(property) : null,
      attachments: attachments.map(toPublicAttachment),
    };
  }

  /**
   * Phase 23A — the single shared ownership rule for every
   * EMPLOYEE-restricted inquiry-modification action: edit (update()),
   * assign/reassign (assign()), and the isPublic toggle
   * (setPublicVisibility()). ADMIN can modify any inquiry; EMPLOYEE only
   * the inquiry currently assigned to them, determined from the live
   * assignedToUserId column — never assignment history, never a cached
   * client value — so this is automatically correct immediately after a
   * reassignment: the previous assignee loses access and the new one
   * gains it the moment assignedToUserId changes, with no separate
   * bookkeeping needed. An unassigned inquiry (assignedToUserId=null) is
   * therefore also not modifiable by an EMPLOYEE through any of these
   * three actions, since null never equals a real actor.userId.
   *
   * Extracted from update()'s pre-existing Phase 18A check rather than
   * duplicating the same condition three times — this codebase already
   * has multiple small private assert*() helpers per service (see
   * assertCustomer/assertProperty below), so a fourth one here matches
   * established style; nothing is shared across service/module
   * boundaries (FollowUpsService has its own, separate helper for the
   * identical rule applied to follow-ups — no cross-module authorization
   * utility exists anywhere in this codebase, so none is introduced here).
   */
  private assertCanModifyInquiry(
    existing: { assignedToUserId: string | null },
    actor: Actor,
  ): void {
    if (actor.role === 'EMPLOYEE' && existing.assignedToUserId !== actor.userId) {
      throw new ForbiddenRoleException('You can only modify inquiries currently assigned to you.');
    }
  }

  private async assertCustomer(customerId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: customerId } });
    if (!user || user.userType !== 'CUSTOMER') {
      throw new CustomerNotFoundException();
    }
  }

  /**
   * Returns the property's location fields (this phase) rather than
   * void — create()/update() need them immediately after for the
   * SELLER location-sync rule, at no extra query cost (this lookup was
   * already happening for the existence check).
   */
  private async assertProperty(propertyId: string): Promise<PropertyLocationSnapshot> {
    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new PropertyNotFoundException();
    }
    return property;
  }

  private async assertApplicationUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.userType !== 'APPLICATION_USER') {
      throw new UserNotFoundException(
        'handledByUserId must reference an existing APPLICATION_USER.',
      );
    }
  }

  /**
   * ADMIN-only, by design (this phase's Requirement 3) — the literal
   * requirement is "application notification when admin assigns inquiry
   * to employee", and the same section explicitly protects
   * employee-to-employee assignment as existing, unrestricted business
   * behavior. Gating strictly on actor.role === 'ADMIN' satisfies both:
   * an EMPLOYEE assigning/reassigning (self-service handoff, already
   * supported before this phase) never creates a notification, but is
   * never blocked or altered either — this call is purely an additive
   * side effect, never a precondition. Never notifies the actor about
   * their own action (an ADMIN can't self-assign into this path in a way
   * that would target themselves, since assignedToUserId here always
   * comes from the request, not defaulted to the actor).
   *
   * Fire-and-forget is deliberately not used — notification creation is
   * awaited like every other side effect in this service (audit, etc.),
   * so a failure here surfaces rather than silently disappearing. It is
   * NOT wrapped in the same $transaction as the assignment write: a
   * notification is a best-effort, additive side effect of a successful
   * assignment, not a correctness requirement of it — the assignment
   * itself must never fail or roll back because notification creation
   * had a problem.
   */
  private async notifyInquiryAssigned(
    actor: Actor,
    inquiryId: string,
    inquiryNumber: string,
    assignedToUserId: string,
  ): Promise<void> {
    if (actor.role !== 'ADMIN') {
      return;
    }

    await this.notificationsService.create({
      userId: assignedToUserId,
      type: 'INQUIRY_ASSIGNED',
      title: 'New inquiry assigned',
      message: `You have been assigned inquiry ${inquiryNumber}.`,
      entityType: 'INQUIRY',
      entityId: inquiryId,
    });
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
