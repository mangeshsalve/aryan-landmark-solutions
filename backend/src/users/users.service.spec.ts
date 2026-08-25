import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService.list (critical paths)', () => {
  let service: UsersService;
  let prisma: { user: { findMany: jest.Mock; count: jest.Mock } };

  const employeeRow = {
    id: 'user-1',
    userId: 'EMP001',
    userType: 'APPLICATION_USER',
    role: 'EMPLOYEE',
    name: 'Employee One',
    email: 'emp1@example.com',
    mobile: '9999999999',
    status: 'ACTIVE',
    passwordHash: 'should-never-be-returned',
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([employeeRow]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UsersService);
  });

  it('always scopes the query to userType=APPLICATION_USER, regardless of other filters', async () => {
    await service.list({ page: 1, pageSize: 20, status: 'ACTIVE' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userType: 'APPLICATION_USER', status: 'ACTIVE' },
      }),
    );
  });

  it('never includes userType in the query as anything other than APPLICATION_USER (CUSTOMER/MASTER excluded)', async () => {
    await service.list({ page: 1, pageSize: 20 });

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.userType).toBe('APPLICATION_USER');
  });

  it('applies pagination the same way as other list endpoints', async () => {
    prisma.user.count.mockResolvedValue(45);

    const result = await service.list({ page: 2, pageSize: 20 });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
    expect(result.pagination).toEqual({ page: 2, pageSize: 20, total: 45, totalPages: 3 });
  });

  it('never exposes passwordHash in the mapped response', async () => {
    const result = await service.list({ page: 1, pageSize: 20 });

    expect(result.data[0]).not.toHaveProperty('passwordHash');
    expect(result.data[0]).not.toHaveProperty('password');
  });
});
