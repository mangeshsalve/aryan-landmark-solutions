import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser, toPublicUser } from '../master/user.mapper';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * GET /users — lists APPLICATION_USER records (ADMIN/EMPLOYEE), primarily
 * to populate the Flutter inquiry-assignment employee picker. Always
 * scopes to userType='APPLICATION_USER' regardless of which other filters
 * are supplied — CUSTOMER and MASTER can never appear here, independent
 * of `status`, since a customer can also be ACTIVE. Reuses the same
 * PublicUser/toPublicUser allow-list mapper as POST /master/users (see
 * ../master/user.mapper.ts) rather than duplicating it — passwordHash is
 * simply never referenced there, so it can't leak here either.
 *
 * This is a read-only candidate list for the picker; InquiriesService.
 * assign() remains the sole authority on whether a given user can actually
 * be assigned (existence, APPLICATION_USER, ACTIVE) — nothing here
 * duplicates or weakens that check.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListUsersQueryDto): Promise<PaginatedResult<PublicUser>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, unknown> = { userType: 'APPLICATION_USER' as const };
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;

    if (query.search && query.search.trim().length > 0) {
      const term = query.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { mobile: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
        { userId: { contains: term, mode: 'insensitive' } },
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
      data: rows.map(toPublicUser),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }
}
