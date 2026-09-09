import { Test, TestingModule } from '@nestjs/testing';
import { InvalidCredentialsException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { MasterAuthService } from './master-auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('MasterAuthService', () => {
  let service: MasterAuthService;
  let prisma: { user: { findFirst: jest.Mock; update: jest.Mock } };
  let passwordService: { verify: jest.Mock };
  let tokenService: { signMasterToken: jest.Mock };

  const masterUser = {
    id: 'master-uuid-1',
    userId: 'MASTER001',
    userType: 'MASTER' as const,
    role: null,
    email: 'master@example.com',
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
    tokenService = { signMasterToken: jest.fn().mockResolvedValue('signed.master.jwt') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MasterAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    service = module.get(MasterAuthService);
  });

  // 7. Valid MASTER login
  it('logs in a valid MASTER user', async () => {
    prisma.user.findFirst.mockResolvedValue(masterUser);
    passwordService.verify.mockResolvedValue(true);

    const result = await service.login('master@example.com', 'correct-password');

    expect(result.accessToken).toBe('signed.master.jwt');
    expect(result.tokenScope).toBe('MASTER');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'master@example.com', mode: 'insensitive' }, userType: 'MASTER' },
    });
    expect(tokenService.signMasterToken).toHaveBeenCalledWith({
      sub: masterUser.id,
      userId: 'MASTER001',
    });
  });

  it('rejects an unknown master email', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.login('nobody@example.com', 'x')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('rejects an invalid master password', async () => {
    prisma.user.findFirst.mockResolvedValue(masterUser);
    passwordService.verify.mockResolvedValue(false);

    await expect(service.login('master@example.com', 'wrong')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('rejects a blocked master account', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...masterUser, status: 'BLOCKED' });

    await expect(service.login('master@example.com', 'correct-password')).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(passwordService.verify).not.toHaveBeenCalled();
  });
});
