import type { Context, Next } from 'hono';
import type { AppEnv } from '../types/bindings';
import { AppError } from '../utils/response';

/**
 * Global error handler — Worker/Hono equivalent of
 * src/common/filters/all-exceptions.filter.ts. Reproduces its behavior
 * exactly (Step 6):
 *  - a known AppError produces { success: false, error: { code, message },
 *    requestId } with its own status/code, same as AppException.
 *  - an unexpected error NEVER exposes its message or stack to the
 *    client — always the same generic message + INTERNAL_ERROR code
 *    (matching the NestJS filter's "Unknown/unexpected errors always
 *    return a generic message; the real error goes to the logger only"
 *    rule) — logged server-side via console.error, which Cloudflare's
 *    own log tooling picks up, the Workers-runtime equivalent of the
 *    NestJS filter logging through PinoLogger.
 *  - 5xx responses are logged; 4xx are not (mirrors the filter's
 *    statusCode >= 500 branch).
 *
 * requestId: the NestJS filter echoes request.id (assigned by
 * nestjs-pino's genReqId, itself reusing an incoming X-Correlation-Id
 * header when present). Reproduced here with the same precedence.
 */
const CORRELATION_ID_HEADER = 'x-correlation-id';

export function getRequestId(c: Context<AppEnv>): string {
  const existing = c.get('requestId');
  if (existing) return existing;
  const incoming = c.req.header(CORRELATION_ID_HEADER);
  const id = incoming && incoming.trim().length > 0 ? incoming : crypto.randomUUID();
  c.set('requestId', id);
  return id;
}

/**
 * Assigns/reads the request id up front and echoes it as a response
 * header — Worker equivalent of RequestIdInterceptor, which echoes the
 * same id nestjs-pino's genReqId assigned. Registered globally in
 * index.ts, ahead of every route.
 */
export async function requestIdMiddleware(c: Context<AppEnv>, next: Next) {
  const id = getRequestId(c);
  await next();
  c.res.headers.set(CORRELATION_ID_HEADER, id);
}

/**
 * Registered via app.notFound() in index.ts. An unmatched route in the
 * existing NestJS backend flows through the exact same envelope as any
 * other exception (Nest's router itself throws a NotFoundException for
 * an unmatched path, which the global filter catches like any other) —
 * Hono's default 404 behavior is a bare "404 Not Found" text response,
 * so this is registered explicitly to match the existing contract rather
 * than leave the default in place.
 */
export function notFoundHandler(c: Context<AppEnv>) {
  const requestId = getRequestId(c);
  return c.json(
    { success: false, error: { code: 'NOT_FOUND', message: 'Cannot find the requested resource.' }, requestId },
    404,
  );
}

export function errorHandler(err: Error, c: Context<AppEnv>) {
  const requestId = getRequestId(c);

  if (err instanceof AppError) {
    if (err.status >= 500) {
      console.error('Server error response', { requestId, code: err.code, err });
    } else {
      console.warn('Client error response', { requestId, code: err.code, status: err.status });
    }
    return c.json(
      { success: false, error: { code: err.code, message: err.message }, requestId },
      err.status as 200 | 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    );
  }

  console.error('Unhandled exception', { requestId, err });
  return c.json(
    {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
      requestId,
    },
    500,
  );
}
