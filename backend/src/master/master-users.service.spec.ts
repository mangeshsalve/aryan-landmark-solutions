import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ApplicationUserDuplicateException } from '../common/exceptions/app.exception';
import { PasswordService } from '../auth/services/password.service';
import { PrismaService } from '../prisma/prisma.service';
import { MasterUsersService } from './master-users.service';

describe('MasterUsersService.create (critical paths)', () => {
  let service: MasterUsersService;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let password: { hash: jest.Mock };

  const actor = { userId: 'master-uuid-1' };

  const baseDto = {
    name: 'New Employee',
    mobile: '9999999999',
    password: 'a-strong-password',
    role: 'EMPLOYEE' as const,
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    password = { hash: jest.fn().mockResolvedValue('hashed-password') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MasterUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: PasswordService, useValue: password },
      ],
    }).compile();

    service = module.get(MasterUsersService);
  });

  it('creates an EMPLOYEE, hashing the password and never returning it', async () => {
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      userId: 'EMP-ABC123',
      userType: 'APPLICATION_USER',
      role: 'EMPLOYEE',
      name: baseDto.name,
      email: null,
      mobile: baseDto.mobile,
      status: 'ACTIVE',
      passwordHash: 'hashed-password',
    });

    const result = await service.create(baseDto, actor);

    expect(password.hash).toHaveBeenCalledWith('a-strong-password');
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userType: 'APPLICATION_USER',
          role: 'EMPLOYEE',
          passwordHash: 'hashed-password',
          createdByUserId: 'master-uuid-1',
        }),
      }),
    );
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('password');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_CREATED' }));
    // Password must never appear in what gets audited either.
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain('a-strong-password');
  });

  it('creates an ADMIN identically', async () => {
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      userId: 'ADM-DEF456',
      userType: 'APPLICATION_USER',
      role: 'ADMIN',
      name: 'New Admin',
      email: null,
      mobile: '8888888888',
      status: 'ACTIVE',
    });

    const result = await service.create({ ...baseDto, role: 'ADMIN', name: 'New Admin' }, actor);

    expect(result.role).toBe('ADMIN');
  });

  it('rejects a duplicate mobile/email before attempting the insert', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'existing-user' });

    await expect(service.create(baseDto, actor)).rejects.toBeInstanceOf(
      ApplicationUserDuplicateException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('maps a unique-constraint race at the actual insert to a clean conflict, not a raw Prisma error', async () => {
    const dbError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    dbError.code = 'P2002';
    prisma.user.create.mockRejectedValue(dbError);

    await expect(service.create(baseDto, actor)).rejects.toBeInstanceOf(
      ApplicationUserDuplicateException,
    );
  });

  it('generates a userId (prefixed by role) when none is supplied', async () => {
    prisma.user.create.mockImplementation(({ data }: { data: { userId: string } }) =>
      Promise.resolve({
        id: 'user-3',
        userId: data.userId,
        userType: 'APPLICATION_USER',
        role: 'EMPLOYEE',
        name: baseDto.name,
        email: null,
        mobile: baseDto.mobile,
        status: 'ACTIVE',
      }),
    );

    const result = await service.create(baseDto, actor);

    expect(result.userId).toMatch(/^EMP-[0-9A-F]{6}$/);
  });
});
