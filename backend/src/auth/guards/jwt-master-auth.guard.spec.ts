import { ExecutionContext } from '@nestjs/common';
import {
  AuthTokenInvalidException,
  MasterAccessRequiredException,
} from '../../common/exceptions/app.exception';
import { TokenService } from '../services/token.service';
import { JwtMasterAuthGuard } from './jwt-master-auth.guard';

function mockContext(authorizationHeader: string | undefined): ExecutionContext {
  const request = { headers: { authorization: authorizationHeader } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtMasterAuthGuard', () => {
  let tokenService: { verifyMasterToken: jest.Mock };
  let guard: JwtMasterAuthGuard;

  beforeEach(() => {
    tokenService = { verifyMasterToken: jest.fn() };
    guard = new JwtMasterAuthGuard(tokenService as unknown as TokenService);
  });

  // 13. MASTER authorization
  it('allows a valid master token and attaches the payload to the request', async () => {
    const payload = { tokenType: 'MASTER', sub: 'm1', userId: 'MASTER001' };
    tokenService.verifyMasterToken.mockResolvedValue(payload);
    const context = mockContext('Bearer valid.master.token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((context.switchToHttp().getRequest() as { user: unknown }).user).toEqual(payload);
  });

  it('rejects a missing Authorization header with AUTH_MASTER_ACCESS_REQUIRED', async () => {
    const context = mockContext(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(MasterAccessRequiredException);
  });

  // 14. Application token cannot access a MASTER-only endpoint
  it('rejects an application token presented to a master-only route', async () => {
    tokenService.verifyMasterToken.mockRejectedValue(new AuthTokenInvalidException());
    const context = mockContext('Bearer some.application.token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(MasterAccessRequiredException);
  });
});
