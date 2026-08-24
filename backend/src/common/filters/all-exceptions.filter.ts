import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

/**
 * Single global error envelope, per docs/api/api-conventions.md:
 *   { success: false, error: { code, message, details? }, requestId }
 *
 * Unknown/unexpected errors always return a generic message to the client;
 * the real error and stack trace go to the logger only, per the
 * error-handling strategy in the greenfield implementation plan.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.id ? String(request.id) : undefined;

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown[] | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const bodyObj = body as Record<string, unknown>;
        message = typeof bodyObj.message === 'string' ? bodyObj.message : exception.message;

        if (Array.isArray(bodyObj.message)) {
          // class-validator ValidationPipe produces an array of messages
          details = bodyObj.message as unknown[];
          message = 'Validation failed.';
        }

        // AppException (see common/exceptions/app.exception.ts) attaches a
        // documented error code directly — prefer it over the generic
        // per-status mapping so e.g. login failures report
        // AUTH_INVALID_CREDENTIALS rather than the generic AUTH_TOKEN_INVALID.
        if (typeof bodyObj.code === 'string') {
          code = bodyObj.code;
        }
      }

      if (code === 'INTERNAL_ERROR') {
        code = mapStatusToCode(statusCode);
      }
    } else if (exception instanceof Error) {
      this.logger.error({ err: exception, requestId, path: request.url }, 'Unhandled exception');
    } else {
      this.logger.error({ exception, requestId, path: request.url }, 'Unknown thrown value');
    }

    if (statusCode >= 500) {
      // Already logged above for Error instances; log HttpException 5xx too.
      if (exception instanceof HttpException) {
        this.logger.error(
          { err: exception, requestId, path: request.url },
          'Server error response',
        );
      }
    } else {
      this.logger.warn({ requestId, path: request.url, statusCode, code }, 'Client error response');
    }

    response.status(statusCode).json({
      success: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      requestId,
    });
  }
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_ERROR';
    case HttpStatus.UNAUTHORIZED:
      return 'AUTH_TOKEN_INVALID';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'FILE_SIZE_LIMIT_EXCEEDED';
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return 'FILE_TYPE_NOT_ALLOWED';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}
