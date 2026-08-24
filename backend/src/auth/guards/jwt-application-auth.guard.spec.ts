import { ExecutionContext } from '@nestjs/common';
import { AuthTokenInvalidException } from '../../common/exceptions/app.exception';
import { JwtApplicationAuthGuard } from './jwt-application-auth.guard';
import { TokenService } from '../services/token.service';

function mockContext(authorizationHeader: string | undefined): ExecutionContext {
  const request = { headers: { authorization: authorizationHeader } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtApplicationAuthGuard', () => {
  let tokenService: { verifyApplicationToken: jest.Mock };
  let guard: JwtApplicationAuthGuard;

  beforeEach(() => {
    tokenService = { verifyApplicationToken: jest.fn() };
    guard = new JwtApplicationAuthGuard(tokenService as unknown as TokenService);
  });

  it('allows a valid application token and attaches the payload to the request', async () => {
    const payload = { tokenType: 'APPLICATION', sub: 'u1', userId: 'EMP001', role: 'EMPLOYEE' };
    tokenService.verifyApplicationToken.mockResolvedValue(payload);
    const context = mockContext('Bearer valid.token.here');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((context.switchToHttp().getRequest() as { user: unknown }).user).toEqual(payload);
  });

  it('rejects a missing Authorization header', async () => {
    const context = mockContext(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthTokenInvalidException);
    expect(tokenService.verifyApplicationToken).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer scheme', async () => {
    const context = mockContext('Basic somevalue');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthTokenInvalidException);
  });

  // 14. Application guard rejects whatever comes back invalid from the
  // token service — including a master token, since TokenService itself
  // throws AuthTokenInvalidException for a master token here (see
  // token.service.spec.ts).
  it('propagates rejection when the underlying token is invalid for this boundary', async () => {
    tokenService.verifyApplicationToken.mockRejectedValue(new AuthTokenInvalidException());
    const context = mockContext('Bearer some.master.token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthTokenInvalidException);
  });
});
