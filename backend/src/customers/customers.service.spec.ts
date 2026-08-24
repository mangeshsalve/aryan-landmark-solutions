import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import {
  CustomerDuplicateException,
  CustomerNotFoundException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from './customers.service';

describe('CustomersService (critical paths)', () => {
  let service: CustomersService;
  let prisma: {
    user: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let audit: { record: jest.Mock };

  const actor = { userId: 'admin-uuid-1' };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(CustomersService);
  });

  it('creates a customer with userType=CUSTOMER, role=null, passwordHash=null, and createdBy/updatedBy from the actor', async () => {
    prisma.user.findFirst.mockResolvedValue(null); // no duplicate
    prisma.user.create.mockResolvedValue({
      id: 'new-customer-id',
      userType: 'CUSTOMER',
      name: 'Jane Doe',
      email: 'jane@example.com',
      mobile: '9999999999',
      alternateMobile: null,
      address: null,
      city: null,
      state: null,
      pincode: null,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.create(
      { name: 'Jane Doe', email: 'jane@example.com', mobile: '9999999999' },
      actor,
    );

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userType: 'CUSTOMER',
        role: null,
        passwordHash: null,
        userId: null,
        createdByUserId: 'admin-uuid-1',
        updatedByUserId: 'admin-uuid-1',
      }),
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CUSTOMER_CREATED', entityId: 'new-customer-id' }),
    );
  });

  it('rejects creating a customer that duplicates an existing mobile/email', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'existing-customer' });

    await expect(
      service.create({ name: 'Dup', mobile: '9999999999' }, actor),
    ).rejects.toBeInstanceOf(CustomerDuplicateException);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never leaks passwordHash from getById even if present on the row', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'c1',
      userType: 'CUSTOMER',
      name: 'X',
      email: null,
      mobile: null,
      alternateMobile: null,
      address: null,
      city: null,
      state: null,
      pincode: null,
      status: 'ACTIVE',
      passwordHash: 'should-never-appear', // defensive: even if a bad row existed
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getById('c1');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('throws CustomerNotFoundException for an unknown id', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.getById('does-not-exist')).rejects.toBeInstanceOf(
      CustomerNotFoundException,
    );
  });

  it('scopes list() to userType=CUSTOMER only', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await service.list({ page: 1, pageSize: 20 });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userType: 'CUSTOMER' }) }),
    );
  });
});
