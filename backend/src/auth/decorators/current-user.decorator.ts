import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';

/**
 * Injects the verified token payload (set by whichever guard ran —
 * JwtApplicationAuthGuard or JwtMasterAuthGuard) into a controller method.
 * This is always derived from the validated JWT, never the request body.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.user;
});
