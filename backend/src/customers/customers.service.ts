import { Injectable } from '@nestjs/common';
import {
  CustomerDuplicateException,
  CustomerNotFoundException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { PublicCustomer, toPublicCustomer } from './customer.mapper';

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * Customer Master Data — CUSTOMER here means a customer record (business
 * master data), not the MASTER management account. Stored in the same
 * users table as everyone else, filtered on userType='CUSTOMER'.
 *
 * Per the business flow this supports (search for an existing customer
 * while creating an inquiry; create one if not found), both ADMIN and
 * EMPLOYEE can create/read/update customers — enforced at the controller
 * via @Roles('ADMIN', 'EMPLOYEE'), not repeated here.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: ListCustomersQueryDto): Promise<PaginatedResult<PublicCustomer>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { userType: 'CUSTOMER' as const };

    if (query.status) {
      where.status = query.status;
    }

    if (query.search && query.search.trim().length > 0) {
      const term = query.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { mobile: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: rows.map(toPublicCustomer),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getById(id: string): Promise<PublicCustomer> {
    const user = await this.prisma.user.findFirst({ where: { id, userType: 'CUSTOMER' } });
    if (!user) {
      throw new CustomerNotFoundException();
    }
    return toPublicCustomer(user);
  }

  async create(
    dto: CreateCustomerDto,
    actor: { userId: string; ipAddress?: string; userAgent?: string },
  ): Promise<PublicCustomer> {
    await this.assertNoDuplicate(dto.mobile, dto.email);

    const created = await this.prisma.user.create({
      data: {
        userType: 'CUSTOMER',
        role: null,
        passwordHash: null,
        userId: null,
        name: dto.name,
        email: dto.email ?? null,
        mobile: dto.mobile ?? null,
        alternateMobile: dto.alternateMobile ?? null,
        address: dto.address ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        pincode: dto.pincode ?? null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'CUSTOMER',
      entityId: created.id,
      action: 'CUSTOMER_CREATED',
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicCustomer(created);
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actor: { userId: string; ipAddress?: string; userAgent?: string },
  ): Promise<PublicCustomer> {
    const existing = await this.prisma.user.findFirst({ where: { id, userType: 'CUSTOMER' } });
    if (!existing) {
      throw new CustomerNotFoundException();
    }

    // Only re-check duplicates if mobile/email are actually changing —
    // otherwise saving a customer's own unchanged record would trip the
    // duplicate check against itself.
    const nextMobile = dto.mobile ?? existing.mobile ?? undefined;
    const nextEmail = dto.email ?? existing.email ?? undefined;
    const mobileChanging = dto.mobile !== undefined && dto.mobile !== existing.mobile;
    const emailChanging = dto.email !== undefined && dto.email !== existing.email;
    if (mobileChanging || emailChanging) {
      await this.assertNoDuplicate(nextMobile, nextEmail, id);
    }

    const oldValues = {
      name: existing.name,
      email: existing.email,
      mobile: existing.mobile,
      alternateMobile: existing.alternateMobile,
      address: existing.address,
      city: existing.city,
      state: existing.state,
      pincode: existing.pincode,
    };

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        email: dto.email ?? undefined,
        mobile: dto.mobile ?? undefined,
        alternateMobile: dto.alternateMobile ?? undefined,
        address: dto.address ?? undefined,
        city: dto.city ?? undefined,
        state: dto.state ?? undefined,
        pincode: dto.pincode ?? undefined,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'CUSTOMER',
      entityId: id,
      action: 'CUSTOMER_UPDATED',
      oldValues,
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicCustomer(updated);
  }

  private async assertNoDuplicate(
    mobile?: string,
    email?: string,
    excludeId?: string,
  ): Promise<void> {
    if (!mobile && !email) {
      return;
    }

    const or: Record<string, unknown>[] = [];
    if (mobile) or.push({ mobile });
    if (email) or.push({ email: { equals: email, mode: 'insensitive' } });

    const existing = await this.prisma.user.findFirst({
      where: {
        userType: 'CUSTOMER',
        OR: or,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
    });

    if (existing) {
      throw new CustomerDuplicateException();
    }
  }
}
