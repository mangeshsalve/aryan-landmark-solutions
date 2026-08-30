import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ForbiddenRoleException,
  PropertyDuplicateException,
  PropertyNotFoundException,
} from '../common/exceptions/app.exception';
import { ApplicationRoleValue } from '../common/types/domain-enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { ListAttachmentsQueryDto } from '../attachments/dto/list-attachments-query.dto';
import { deriveSyncedLocationFromProperty } from '../inquiries/location-match.util';
import { CreatePropertyDto } from './dto/create-property.dto';
import { ListPropertiesQueryDto } from './dto/list-properties-query.dto';
import { ListPublicPropertiesQueryDto } from './dto/list-public-properties-query.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import { generatePropertyCode } from './property-code.util';
import {
  PublicProperty,
  PublicPropertyListing,
  toPublicPhoto,
  toPublicProperty,
} from './property.mapper';

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

const MAX_PROPERTY_CODE_ATTEMPTS = 5;

/**
 * Property Master Data. ADMIN and EMPLOYEE both have full create/read/
 * update access; CUSTOMER never reaches this (no application JWT); MASTER
 * is not granted access here since no authoritative document defines
 * master property-management access.
 */
@Injectable()
export class PropertiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  async list(query: ListPropertiesQueryDto): Promise<PaginatedResult<PublicProperty>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.category) where.category = query.category;
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };

    if (query.search && query.search.trim().length > 0) {
      const term = query.search.trim();
      where.OR = [
        { propertyCode: { contains: term, mode: 'insensitive' } },
        { propertyType: { contains: term, mode: 'insensitive' } },
        { locality: { contains: term, mode: 'insensitive' } },
        { address: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.property.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.property.count({ where }),
    ]);

    return {
      data: rows.map(toPublicProperty),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /**
   * GET /public/properties (Phase 8/8.1) — unauthenticated, for website
   * visitors. Reuses this same service/mapper rather than duplicating
   * property query logic, but is a separate method (not a change to
   * list()) so internal ADMIN/EMPLOYEE listing behavior is untouched.
   *
   * Requires BOTH isPublic=true AND status=AVAILABLE — isPublic alone is
   * not sufficient (an ADMIN could mark a SOLD property isPublic without
   * intending it to reappear here). Also includes PHOTO attachments only
   * (never DOCUMENT/RECORDING), mapped through toPublicPhoto() — a
   * deliberately narrow shape with no r2Bucket/r2ObjectKey/uploadedBy.
   */
  async listPublic(
    query: ListPublicPropertiesQueryDto,
  ): Promise<PaginatedResult<PublicPropertyListing>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { isPublic: true, status: 'AVAILABLE' };
    if (query.category) where.category = query.category;
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };

    const [rows, total] = await Promise.all([
      this.prisma.property.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.property.count({ where }),
    ]);

    const propertyIds = rows.map((row) => row.id);
    const photos = propertyIds.length
      ? await this.prisma.attachment.findMany({
          where: { propertyId: { in: propertyIds }, attachmentType: 'PHOTO' },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        })
      : [];

    const photosByProperty = new Map<string, typeof photos>();
    for (const photo of photos) {
      if (!photo.propertyId) continue;
      const bucket = photosByProperty.get(photo.propertyId) ?? [];
      bucket.push(photo);
      photosByProperty.set(photo.propertyId, bucket);
    }

    return {
      data: rows.map((row) => ({
        ...toPublicProperty(row),
        photos: (photosByProperty.get(row.id) ?? []).map(toPublicPhoto),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getById(id: string): Promise<PublicProperty> {
    const property = await this.prisma.property.findUnique({ where: { id } });
    if (!property) {
      throw new PropertyNotFoundException();
    }
    return toPublicProperty(property);
  }

  async create(dto: CreatePropertyDto, actor: Actor): Promise<PublicProperty> {
    const propertyCode = await this.resolveCreateCode(dto.propertyCode);

    const created = await this.prisma.property.create({
      data: {
        propertyCode,
        propertyType: dto.propertyType,
        category: dto.category,
        area: dto.area ?? null,
        areaUnit: dto.areaUnit ?? null,
        price: dto.price ?? null,
        // Not client-settable (this phase) — India-only application,
        // price is always INR. See CreatePropertyDto's doc comment.
        priceUnit: 'INR',
        gatNoDetails: dto.gatNoDetails ?? null,
        description: dto.description ?? null,
        address: dto.address ?? null,
        locality: dto.locality ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        pincode: dto.pincode ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        mapUrl: dto.mapUrl ?? null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'PROPERTY',
      entityId: created.id,
      action: 'PROPERTY_CREATED',
      newValues: { ...dto, propertyCode },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicProperty(created);
  }

  /**
   * Transactional as of this phase — a property's own row update and its
   * propagation to every linked SELLER inquiry's location snapshot
   * (below) must succeed or fail together, or the two sources could end
   * up divergent, which is exactly what the unified-location design is
   * meant to prevent (see InquiriesService's location-sync doc comments).
   * No other change to this method's prior behavior.
   */
  async update(id: string, dto: UpdatePropertyDto, actor: Actor): Promise<PublicProperty> {
    const existing = await this.prisma.property.findUnique({ where: { id } });
    if (!existing) {
      throw new PropertyNotFoundException();
    }

    // isPublic is ADMIN-only (Phase 8.1) — role comes from the verified
    // JWT (see PropertiesController), never trusted from the request
    // body. EMPLOYEE has full property update access otherwise; this is
    // the one field carved out of that.
    if (dto.isPublic !== undefined && actor.role !== 'ADMIN') {
      throw new ForbiddenRoleException();
    }

    if (dto.propertyCode && dto.propertyCode !== existing.propertyCode) {
      const conflict = await this.prisma.property.findUnique({
        where: { propertyCode: dto.propertyCode },
      });
      if (conflict) {
        throw new PropertyDuplicateException();
      }
    }

    const oldValues = {
      propertyCode: existing.propertyCode,
      propertyType: existing.propertyType,
      category: existing.category,
      status: existing.status,
      isPublic: existing.isPublic,
    };

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const result = await tx.property.update({
        where: { id },
        data: {
          propertyCode: dto.propertyCode ?? undefined,
          propertyType: dto.propertyType ?? undefined,
          category: dto.category ?? undefined,
          area: dto.area ?? undefined,
          areaUnit: dto.areaUnit ?? undefined,
          price: dto.price ?? undefined,
          // priceUnit is not in UpdatePropertyDto (this phase) — never
          // updated after creation, stays 'INR' for the life of the row.
          gatNoDetails: dto.gatNoDetails ?? undefined,
          description: dto.description ?? undefined,
          address: dto.address ?? undefined,
          locality: dto.locality ?? undefined,
          city: dto.city ?? undefined,
          state: dto.state ?? undefined,
          pincode: dto.pincode ?? undefined,
          latitude: dto.latitude ?? undefined,
          longitude: dto.longitude ?? undefined,
          mapUrl: dto.mapUrl ?? undefined,
          status: dto.status ?? undefined,
          isPublic: dto.isPublic ?? undefined,
          updatedByUserId: actor.userId,
        },
      });

      // Location propagation (this phase, approved plan) — only when
      // city/state/pincode/locality actually changed, and only ever
      // reaches SELLER inquiries (BUYER's own location is never
      // property-derived). Uses the *result* of this write (not dto
      // directly), so a field this request left untouched propagates
      // its already-existing value rather than an accidental undefined.
      const locationChanged =
        result.city !== existing.city ||
        result.state !== existing.state ||
        result.pincode !== existing.pincode ||
        result.locality !== existing.locality;

      if (locationChanged) {
        const synced = deriveSyncedLocationFromProperty(result);
        await tx.inquiry.updateMany({
          where: { propertyId: id, type: 'SELLER' },
          data: synced,
        });
      }

      return result;
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'PROPERTY',
      entityId: id,
      action: 'PROPERTY_UPDATED',
      oldValues,
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicProperty(updated);
  }

  /**
   * DELETE /properties/{id} (Phase 18A Part 7). ADMIN-only, enforced at
   * the controller. Relationships inspected before writing this:
   * inquiries.property_id is ON DELETE SET NULL (schema.sql/baseline
   * migration) — a property can already be safely deleted while
   * inquiries reference it; they just lose that property link and fall
   * back to the same "no property yet" state a lightweight inquiry
   * starts in (Phase 13B), nothing breaks. attachments.property_id is
   * ON DELETE CASCADE, so the DB alone won't orphan rows — but it also
   * won't touch R2, so (same reasoning as InquiriesService.delete())
   * property-linked attachments are removed first through
   * AttachmentsService.remove(), one at a time, before the property row
   * itself is deleted.
   */
  async delete(id: string, actor: Actor): Promise<void> {
    const existing = await this.prisma.property.findUnique({ where: { id } });
    if (!existing) {
      throw new PropertyNotFoundException();
    }

    const attachments = await this.attachmentsService.list({
      propertyId: id,
    } as ListAttachmentsQueryDto);
    for (const attachment of attachments) {
      await this.attachmentsService.remove(attachment.id, actor);
    }

    await this.prisma.property.delete({ where: { id } });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'PROPERTY',
      entityId: id,
      action: 'PROPERTY_DELETED',
      oldValues: { propertyCode: existing.propertyCode, status: existing.status },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  /**
   * If the client supplied a code, use it after checking it's free
   * (otherwise reject as a conflict rather than silently generating a
   * different one). Otherwise generate one, retrying on the rare
   * collision — see property-code.util.ts for why this exists at all.
   */
  private async resolveCreateCode(requested?: string): Promise<string> {
    if (requested) {
      const existing = await this.prisma.property.findUnique({
        where: { propertyCode: requested },
      });
      if (existing) {
        throw new PropertyDuplicateException();
      }
      return requested;
    }

    for (let attempt = 0; attempt < MAX_PROPERTY_CODE_ATTEMPTS; attempt++) {
      const candidate = generatePropertyCode();
      const existing = await this.prisma.property.findUnique({
        where: { propertyCode: candidate },
      });
      if (!existing) {
        return candidate;
      }
    }

    throw new Error('Failed to generate a unique property code after several attempts.');
  }
}
