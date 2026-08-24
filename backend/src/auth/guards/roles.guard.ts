import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApplicationRoleValue } from '../../common/types/domain-enums';
import { ForbiddenRoleException } from '../../common/exceptions/app.exception';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';

/**
 * Reads role from the verified JWT payload only (request.user, set by
 * JwtApplicationAuthGuard) — never from the request body. Must be applied
 * AFTER JwtApplicationAuthGuard in a route's @UseGuards(...) list, e.g.
 * @UseGuards(JwtApplicationAuthGuard, RolesGuard), since Nest runs guards
 * in the order given and RolesGuard depends on request.user already being
 * populated.
 *
 * A master token never satisfies this guard: MasterJwtPayload has no
 * `role` field, so request.user.role is undefined for a master token and
 * the check fails closed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<ApplicationRoleValue[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = 'role' in request.user ? request.user.role : undefined;

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenRoleException();
    }

    return true;
  }
}
