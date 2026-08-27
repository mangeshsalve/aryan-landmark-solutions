import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ApplicationUserDuplicateException,
  UserNotFoundException,
} from '../common/exceptions/app.exception';
import { ApplicationRoleValue } from '../common/types/domain-enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/services/password.service';
import { generateApplicationUserId } from './application-user-id.util';
import { CreateApplicationUserDto } from './dto/create-application-user.dto';
import { UpdateApplicationUserDto } from './dto/update-application-user.dto';
import { PublicUser, toPublicUser } from './user.mapper';

interface Actor {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

const MAX_USER_ID_ATTEMPTS = 5;

/**
 * /master/users (Phase 9B create; Phase 15A update/list). MASTER-only —
 * manages APPLICATION_USER (ADMIN or EMPLOYEE) rows only, never MASTER or
 * CUSTOMER. Reuses PasswordService (same bcrypt config as login) and
 * AuditService; does not touch authentication itself — deactivating a
 * user here only blocks *future* logins (ApplicationAuthService.login
 * already rejects status != 'ACTIVE'); it does not revoke an
 * already-issued JWT, since verification is stateless (signature +
 * expiry only, no per-request DB status check — see TokenService). Same
 * for a role change: a currently-held JWT keeps its old `role` claim
 * until it expires or the user logs in again. This is existing,
 * unmodified authentication behavior, not something this phase changes.
 * List (GET /master/users) delegates to UsersService.list() — same
 * page/pageSize/role/status/search filters as GET /users, just exposed
 * under the master-JWT boundary too (see MasterUsersController).
 */
@Injectable()
export class MasterUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly passwordService: PasswordService,
  ) {}

  async create(dto: CreateApplicationUserDto, actor: Actor): Promise<PublicUser> {
    await this.assertNoDuplicate(dto.email, dto.mobile);

    const userId = dto.userId
      ? await this.assertUserIdFree(dto.userId)
      : await this.generateFreeUserId(dto.role);

    const passwordHash = await this.passwordService.hash(dto.password);

    let created;
    try {
      created = await this.prisma.user.create({
        data: {
          userType: 'APPLICATION_USER',
          userId,
          role: dto.role,
          passwordHash,
          name: dto.name,
          email: dto.email ?? null,
          mobile: dto.mobile,
          alternateMobile: dto.alternateMobile ?? null,
          address: dto.address ?? null,
          city: dto.city ?? null,
          state: dto.state ?? null,
          pincode: dto.pincode ?? null,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
        },
      });
    } catch (err) {
      // Protects the write itself against the check-then-insert race on
      // userId/email (both real DB-level unique constraints) — the
      // application-level assertNoDuplicate/assertUserIdFree checks above
      // narrow the window but can't close it alone.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApplicationUserDuplicateException();
      }
      throw err;
    }

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'USER',
      entityId: created.id,
      action: 'USER_CREATED',
      newValues: {
        userId,
        role: dto.role,
        name: dto.name,
        email: dto.email ?? null,
        mobile: dto.mobile,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicUser(created);
  }

  /**
   * MASTER-only, per the same scope as create() — an APPLICATION_USER
   * (ADMIN/EMPLOYEE). Editing a MASTER or CUSTOMER row through this
   * endpoint is structurally impossible: the userType filter below means
   * a MASTER's own row (userType='MASTER') can never be `existing` here,
   * so a Master Admin can never deactivate/reassign-role/edit themselves
   * via this API — the self-lockout risks in Phase 15A's Part 12 don't
   * apply, by construction, not by an extra runtime check.
   */
  async update(id: string, dto: UpdateApplicationUserDto, actor: Actor): Promise<PublicUser> {
    const existing = await this.prisma.user.findFirst({
      where: { id, userType: 'APPLICATION_USER' },
    });
    if (!existing) {
      throw new UserNotFoundException();
    }

    // Only re-check duplicates if mobile/email are actually changing —
    // same reasoning as CustomersService.update().
    const mobileChanging = dto.mobile !== undefined && dto.mobile !== existing.mobile;
    const emailChanging = dto.email !== undefined && dto.email !== existing.email;
    if (mobileChanging || emailChanging) {
      await this.assertNoDuplicate(
        dto.email ?? existing.email ?? undefined,
        dto.mobile ?? existing.mobile ?? undefined,
        id,
      );
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
      role: existing.role,
      status: existing.status,
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
        role: dto.role ?? undefined,
        status: dto.status ?? undefined,
        updatedByUserId: actor.userId,
      },
    });

    await this.auditService.record({
      userId: actor.userId,
      entityType: 'USER',
      entityId: id,
      action: 'USER_UPDATED',
      oldValues,
      newValues: { ...dto },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toPublicUser(updated);
  }

  private async assertNoDuplicate(
    email?: string,
    mobile?: string,
    excludeId?: string,
  ): Promise<void> {
    const or: Record<string, unknown>[] = [];
    if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
    if (mobile) or.push({ mobile });
    if (or.length === 0) return;

    const existing = await this.prisma.user.findFirst({
      where: {
        userType: 'APPLICATION_USER',
        OR: or,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
    });
    if (existing) {
      throw new ApplicationUserDuplicateException();
    }
  }

  private async assertUserIdFree(userId: string): Promise<string> {
    const existing = await this.prisma.user.findUnique({ where: { userId } });
    if (existing) {
      throw new ApplicationUserDuplicateException('A user with this userId already exists.');
    }
    return userId;
  }

  private async generateFreeUserId(role: ApplicationRoleValue): Promise<string> {
    for (let attempt = 0; attempt < MAX_USER_ID_ATTEMPTS; attempt++) {
      const candidate = generateApplicationUserId(role);
      const existing = await this.prisma.user.findUnique({ where: { userId: candidate } });
      if (!existing) {
        return candidate;
      }
    }
    throw new Error('Failed to generate a unique userId after several attempts.');
  }
}
