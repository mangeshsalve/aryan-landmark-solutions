import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthTokenInvalidException } from '../../common/exceptions/app.exception';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { TokenService } from '../services/token.service';
import { extractBearerToken } from './extract-bearer-token';

/**
 * Verifies an application JWT (ADMIN/EMPLOYEE), signed with
 * JWT_ACCESS_SECRET. A master token cannot pass this guard: it's signed
 * with a different secret entirely, so verification fails before the
 * tokenType check is even reached.
 */
@Injectable()
export class JwtApplicationAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new AuthTokenInvalidException('Missing bearer token.');
    }

    request.user = await this.tokenService.verifyApplicationToken(token);
    return true;
  }
}
