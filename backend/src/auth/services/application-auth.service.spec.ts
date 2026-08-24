import { Test, TestingModule } from '@nestjs/testing';
import { InvalidCredentialsException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationAuthService } from './application-auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('ApplicationAuthService', () => {
  let service: ApplicationAuthService;
  let prisma: { user: { findFirst: jest.Mock; update: jest.Mock } };
  let passwordService: { verify: jest.Mock };
  let tokenService: { signApplicationToken: jest.Mock };

  const baseUser = {
    id: 'user-uuid-1',
    userId: 'EMP001',
    userType: 'APPLICATION_USER' as const,
    role: 'EMPLOYEE' as const,
    name: 'Test Employee',
    email: null,
    mobile: null,
    passwordHash: 'hashed-password',
    status: 'ACTIVE' as const,
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    passwordService = { verify: jest.fn() };
    tokenService = { signApplicationToken: jest.fn().mockResolvedValue('signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    service = module.get(ApplicationAuthService);
  });

  // 1. Valid ADMIN login
  it('logs in a valid ADMIN user', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...baseUser, role: 'ADMIN', userId: 'ADM001' });
    passwordService.verify.mockResolvedValue(true);

    const result = await service.login('ADM001', 'correct-password');

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user.role).toBe('ADMIN');
    expect(tokenService.signApplicationToken).toHaveBeenCalledWith({
      sub: baseUser.id,
      userId: 'ADM001',
      role: 'ADMIN',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: baseUser.id },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  // 2. Valid EMPLOYEE login
  it('logs in a valid EMPLOYEE user', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser);
    passwordService.verify.mockResolvedValue(true);

    const result = await service.login('EMP001', 'correct-password');

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user.role).toBe('EMPLOYEE');
  });

  // 3. Invalid password
  it('rejects an invalid password', async () => {
    prisma.user.findFirst.mockResolvedValue(baseUser);
    passwordService.verify.mockResolvedValue(false);

    await expect(service.login('EMP001', 'wrong-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(tokenService.signApplicationToken).not.toHaveBeenCalled();
  });

  // 4. Unknown user
  it('rejects an unknown user', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.login('NOBODY', 'any-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(passwordService.verify).not.toHaveBeenCalled();
  });

  // 5. Inactive user
  it('rejects an inactive user even with the correct password', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...baseUser, status: 'INACTIVE' });

    await expect(service.login('EMP001', 'correct-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    // Fails closed before even checking the password, to avoid a timing
    // side-channel revealing whether the account exists/is active.
    expect(passwordService.verify).not.toHaveBeenCalled();
  });

  // 6. Blocked user
  it('rejects a blocked user even with the correct password', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...baseUser, status: 'BLOCKED' });

    await expect(service.login('EMP001', 'correct-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(passwordService.verify).not.toHaveBeenCalled();
  });

  // 8. CUSTOMER cannot login (structurally: customers have no user_id, so
  // the userType='APPLICATION_USER' filter never matches them; this test
  // simulates the resulting "not found" from the database layer).
  it('rejects a login attempt that resolves to no APPLICATION_USER row (customer case)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.login('some-customer-name', 'any-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { userId: 'some-customer-name', userType: 'APPLICATION_USER' },
    });
  });
});
