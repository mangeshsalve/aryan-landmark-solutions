import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Echoes the request ID (assigned by nestjs-pino's genReqId — see
 * LoggingModule) back to the client on every response, so a
 * client-reported error can be traced to exact log lines.
 *
 * Runs as an interceptor (inside Nest's own request pipeline) rather than
 * raw middleware, so it doesn't race against pino-http's own middleware
 * registration order.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (request.id) {
      response.setHeader(CORRELATION_ID_HEADER, String(request.id));
    }

    return next.handle();
  }
}
