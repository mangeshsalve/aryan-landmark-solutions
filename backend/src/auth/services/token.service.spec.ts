import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthTokenInvalidException } from '../../common/exceptions/app.exception';
import { TokenService } from './token.service';

describe('TokenService', () => {
  let tokenService: TokenService;

  const config: Record<string, string> = {
    JWT_ACCESS_SECRET: 'application-secret-at-least-16-chars',
    MASTER_JWT_ACCESS_SECRET: 'master-secret-completely-different',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        TokenService,
        JwtService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();

    tokenService = module.get(TokenService);
  });

  // 9. Application JWT validation
  it('signs and validates an application token round-trip', async () => {
    const token = await tokenService.signApplicationToken({
      sub: 'user-1',
      userId: 'EMP001',
      role: 'EMPLOYEE',
    });

    const payload = await tokenService.verifyApplicationToken(token);

    expect(payload).toMatchObject({
      tokenType: 'APPLICATION',
      sub: 'user-1',
      userId: 'EMP001',
      role: 'EMPLOYEE',
    });
  });

  // 10. Master JWT validation
  it('signs and validates a master token round-trip', async () => {
    const token = await tokenService.signMasterToken({ sub: 'master-1', userId: 'MASTER001' });

    const payload = await tokenService.verifyMasterToken(token);

    expect(payload).toMatchObject({
      tokenType: 'MASTER',
      sub: 'master-1',
      userId: 'MASTER001',
    });
  });

  it('rejects a malformed application token', async () => {
    await expect(tokenService.verifyApplicationToken('not-a-real-token')).rejects.toBeInstanceOf(
      AuthTokenInvalidException,
    );
  });

  // 14/15 at the token-service layer: a token signed for one boundary is
  // rejected outright when verified against the other secret — this is
  // the structural guarantee the guards rely on.
  it('rejects an application token when verified as a master token', async () => {
    const appToken = await tokenService.signApplicationToken({
      sub: 'user-1',
      userId: 'EMP001',
      role: 'ADMIN',
    });

    await expect(tokenService.verifyMasterToken(appToken)).rejects.toBeInstanceOf(
      AuthTokenInvalidException,
    );
  });

  it('rejects a master token when verified as an application token', async () => {
    const masterToken = await tokenService.signMasterToken({
      sub: 'master-1',
      userId: 'MASTER001',
    });

    await expect(tokenService.verifyApplicationToken(masterToken)).rejects.toBeInstanceOf(
      AuthTokenInvalidException,
    );
  });
});
