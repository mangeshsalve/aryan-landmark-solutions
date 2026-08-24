import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenRoleException } from '../../common/exceptions/app.exception';
import { RolesGuard } from './roles.guard';

function mockContext(user: Record<string, unknown>): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  function guardWithRequiredRoles(roles: string[] | undefined) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('allows the route through when no @Roles() metadata is set', () => {
    const guard = guardWithRequiredRoles(undefined);
    const context = mockContext({ tokenType: 'APPLICATION', role: 'EMPLOYEE' });

    expect(guard.canActivate(context)).toBe(true);
  });

  // 11. ADMIN authorization
  it('allows an ADMIN user through an ADMIN-only route', () => {
    const guard = guardWithRequiredRoles(['ADMIN']);
    const context = mockContext({ tokenType: 'APPLICATION', role: 'ADMIN' });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects an EMPLOYEE on an ADMIN-only route', () => {
    const guard = guardWithRequiredRoles(['ADMIN']);
    const context = mockContext({ tokenType: 'APPLICATION', role: 'EMPLOYEE' });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenRoleException);
  });

  // 12. EMPLOYEE authorization
  it('allows an EMPLOYEE user through a route permitting ADMIN or EMPLOYEE', () => {
    const guard = guardWithRequiredRoles(['ADMIN', 'EMPLOYEE']);
    const context = mockContext({ tokenType: 'APPLICATION', role: 'EMPLOYEE' });

    expect(guard.canActivate(context)).toBe(true);
  });

  // 15. MASTER token cannot be treated as ADMIN/EMPLOYEE — a
  // MasterJwtPayload has no `role` field at all, so this fails closed
  // rather than coincidentally matching.
  it('rejects a master token payload (no role field) on a role-guarded route', () => {
    const guard = guardWithRequiredRoles(['ADMIN']);
    const context = mockContext({ tokenType: 'MASTER' });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenRoleException);
  });
});
