import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { MasterAccessRequiredException } from '../../common/exceptions/app.exception';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { TokenService } from '../services/token.service';
import { extractBearerToken } from './extract-bearer-token';

/**
 * Verifies a master-scoped JWT, signed with MASTER_JWT_ACCESS_SECRET.
 * An application (ADMIN/EMPLOYEE) token cannot pass this guard for the
 * same structural reason JwtApplicationAuthGuard rejects master tokens:
 * different signing secret entirely, independent of any role claim.
 *
 * Failure reports AUTH_MASTER_ACCESS_REQUIRED specifically, per
 * docs/api/api-conventions.md's error code list, rather than the generic
 * AUTH_TOKEN_INVALID.
 */
@Injectable()
export class JwtMasterAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new MasterAccessRequiredException();
    }

    try {
      request.user = await this.tokenService.verifyMasterToken(token);
    } catch {
      throw new MasterAccessRequiredException();
    }

    return true;
  }
}
