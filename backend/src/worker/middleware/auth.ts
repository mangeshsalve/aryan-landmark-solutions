import type { Context, Next } from 'hono';
import type { ApplicationRole, AppEnv } from '../types/bindings';
import {
  AuthTokenInvalidError,
  ForbiddenRoleError,
  MasterAccessRequiredError,
} from '../utils/response';
import { verifyApplicationToken, verifyMasterToken } from '../utils/jwt';

/**
 * Reusable authentication/authorization middleware — Step 9. Mirrors the
 * three existing NestJS guards exactly:
 *
 *   requireApplicationAuth  ~  JwtApplicationAuthGuard
 *   requireMasterAuth       ~  JwtMasterAuthGuard
 *   requireRoles(...)       ~  RolesGuard
 *
 * The application/master boundary separation is structural, not a
 * config toggle: requireApplicationAuth verifies against
 * JWT_ACCESS_SECRET only, requireMasterAuth against
 * MASTER_JWT_ACCESS_SECRET only — a token signed for one is
 * cryptographically incapable of passing the other, exactly as the
 * existing backend's two-guard design guarantees today. No route is
 * created in this phase to exercise them; validation is via the JWT
 * infrastructure directly (see the Phase 2 report).
 */

function extractBearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Equivalent to JwtApplicationAuthGuard. Populates c.var.applicationUser
 * on success.
 *
 * Phase 35: after signature/expiry/tokenType verification succeeds, also
 * re-checks the token holder's *current* status against `users` — the
 * approved minimum change that lets ADMIN-driven deactivation actually
 * end an already-issued 30-day session, rather than only affecting future
 * logins. Deliberately the smallest possible lookup (one indexed column,
 * by primary key) since this now runs on every application-authenticated
 * request. Any outcome other than a genuinely still-ACTIVE row (missing
 * row, wrong status) collapses into the same generic 401
 * AuthTokenInvalidError as a bad signature — this must not leak *why*
 * a token was rejected, same principle as login's single generic
 * InvalidCredentialsError.
 */
export async function requireApplicationAuth(c: Context<AppEnv>, next: Next) {
  const token = extractBearerToken(c);
  if (!token) {
    throw new AuthTokenInvalidError('Missing bearer token.');
  }
  let payload;
  try {
    payload = await verifyApplicationToken(token, c.env.JWT_ACCESS_SECRET);
  } catch {
    throw new AuthTokenInvalidError();
  }

  const row = await c.env.DB.prepare('SELECT status FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<{
      status: string;
    }>();
  if (!row || row.status !== 'ACTIVE') {
    throw new AuthTokenInvalidError();
  }

  c.set('applicationUser', payload);
  await next();
}

/** Equivalent to JwtMasterAuthGuard. Populates c.var.masterUser on success. */
export async function requireMasterAuth(c: Context<AppEnv>, next: Next) {
  const token = extractBearerToken(c);
  if (!token) {
    throw new MasterAccessRequiredError();
  }
  try {
    const payload = await verifyMasterToken(token, c.env.MASTER_JWT_ACCESS_SECRET);
    c.set('masterUser', payload);
  } catch {
    throw new MasterAccessRequiredError();
  }
  await next();
}

/**
 * Equivalent to RolesGuard + @Roles(...). Must run after
 * requireApplicationAuth (reads c.var.applicationUser, set by it) — same
 * ordering requirement the NestJS guard has (@UseGuards(
 * JwtApplicationAuthGuard, RolesGuard), guards run in the order given).
 * MASTER routes have no role-based variant, same as the existing
 * backend: MasterJwtPayload carries no `role` field — there is only one
 * master privilege level, so passing requireMasterAuth is itself
 * sufficient authorization, exactly as today.
 */
export function requireRoles(...roles: ApplicationRole[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get('applicationUser');
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenRoleError();
    }
    await next();
  };
}
