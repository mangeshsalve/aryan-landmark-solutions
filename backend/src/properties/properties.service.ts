import { Injectable } from '@nestjs/common';
import {
  PropertyDuplicateException,
  PropertyNotFoundException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreatePropertyDto } from './dto/create-property.dto';
import { ListPropertiesQueryDto } from './dto/list-properties-query.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import { generatePropertyCode } from './property-code.util';
import { PublicProperty, toPublicProperty } from './property.mapper';

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface Actor {
  userId: string;
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
        priceUnit: dto.priceUnit ?? null,
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

  async update(id: string, dto: UpdatePropertyDto, actor: Actor): Promise<PublicProperty> {
    const existing = await this.prisma.property.findUnique({ where: { id } });
    if (!existing) {
      throw new PropertyNotFoundException();
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
    };

    const updated = await this.prisma.property.update({
      where: { id },
      data: {
        propertyCode: dto.propertyCode ?? undefined,
        propertyType: dto.propertyType ?? undefined,
        category: dto.category ?? undefined,
        area: dto.area ?? undefined,
        areaUnit: dto.areaUnit ?? undefined,
        price: dto.price ?? undefined,
        priceUnit: dto.priceUnit ?? undefined,
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
        updatedByUserId: actor.userId,
      },
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
