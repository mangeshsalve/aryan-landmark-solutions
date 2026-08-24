import { SetMetadata } from '@nestjs/common';
import { ApplicationRoleValue } from '../../common/types/domain-enums';

export const ROLES_KEY = 'roles';

/**
 * Declares which ADMIN/EMPLOYEE roles may access a route. Must be paired
 * with JwtApplicationAuthGuard running first (RolesGuard reads
 * request.user.role, which only JwtApplicationAuthGuard populates) — see
 * RolesGuard's doc comment for the required guard order.
 */
export const Roles = (...roles: ApplicationRoleValue[]) => SetMetadata(ROLES_KEY, roles);
