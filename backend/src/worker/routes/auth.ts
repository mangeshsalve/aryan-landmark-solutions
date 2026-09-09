import { Hono, type Context } from 'hono';
import type { AppEnv } from '../types/bindings';
import { InvalidCredentialsError, ok, RateLimitedError, ValidationError } from '../utils/response';
import { verifyPassword } from '../utils/password';
import { signApplicationToken, signMasterToken } from '../utils/jwt';
import { nowIso } from '../utils/id';
import { isValidEmail } from '../utils/format-validators';

/**
 * POST /api/v1/auth/login + POST /api/v1/master-auth/login — ported
 * field-for-field from AuthController/MasterAuthController and
 * ApplicationAuthService/MasterAuthService. Source of truth verified by
 * direct read this phase, not assumed from any prior report.
 *
 * Phase 36: both routes are now gated by their own independent
 * Cloudflare Rate Limiting binding (LOGIN_RATE_LIMITER /
 * MASTER_LOGIN_RATE_LIMITER — see wrangler.production.jsonc's
 * `ratelimits` array and types/bindings.ts), keyed on source IP only.
 * Everything below the rate-limit check — validation, the generic
 * InvalidCredentialsError failure principle, last_login_at, JWT
 * generation, response shape — is unchanged from Phase 35.
 */

// Phase 35: raised from 3600s to 30 days — must stay in sync with
// utils/jwt.ts's own APPLICATION_TOKEN_EXPIRES_IN_SECONDS (the actual
// value baked into the signed token's exp claim); this constant only
// feeds the response's `expiresIn` field.
const APPLICATION_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MASTER_TOKEN_EXPIRES_IN_SECONDS = 3600;

interface UserRow {
  id: string;
  user_id: string | null;
  user_type: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  password_hash: string | null;
  status: string;
}

/**
 * Matches LoginDto exactly: email (@IsEmail, 1-50 chars), password
 * (@IsString, 1-200 chars). Phase 9: email format is now checked via the
 * real `validator` package's isEmail() (see utils/format-validators.ts)
 * — byte-perfect parity with class-validator's @IsEmail(), not a
 * hand-rolled approximation.
 */
function parseLoginBody(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body must be an object.');
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || email.length < 1 || email.length > 50 || !isValidEmail(email)) {
    throw new ValidationError('email must be a valid email address, 1-50 characters.');
  }
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
    throw new ValidationError('password must be 1-200 characters.');
  }
  return { email, password };
}

/**
 * Phase 36 — enforces one of the two independent Cloudflare Rate
 * Limiting bindings before any body parsing, DB lookup, or password
 * verification happens, so a rate-limited request never reaches (and
 * never leaks anything from) the real login logic below it. Keyed on
 * source IP only (`cf-connecting-ip`, the same header already used
 * elsewhere in this codebase for audit logging, e.g. utils/audit.ts
 * call sites) — no email-based keying in this phase, per the approved
 * design. Falls back to the literal string 'unknown' when the header is
 * absent (local `wrangler dev` without Cloudflare's edge in front of
 * it) rather than skipping the check — every request still counts
 * against a single shared bucket locally, which is what makes the rate
 * limiter observable at all outside real Cloudflare traffic.
 */
async function enforceLoginRateLimit(limiter: RateLimit, c: Context<AppEnv>): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: ip });
  if (!success) {
    throw new RateLimitedError();
  }
}

export const authRoutes = new Hono<AppEnv>();

/**
 * POST /api/v1/auth/login — ApplicationAuthService.login() exactly:
 * case-insensitive email lookup scoped to userType='APPLICATION_USER',
 * a single generic AUTH_INVALID_CREDENTIALS response for every failure
 * (unknown email, wrong password, inactive/blocked, or a matched row
 * missing passwordHash/role) so the API never reveals which part of the
 * attempt was wrong — same as the original. lastLoginAt is updated on
 * success. The response's `user` object never includes password_hash —
 * only the same 8 fields ApplicationLoginResult.user declares.
 */
authRoutes.post('/auth/login', async (c) => {
  await enforceLoginRateLimit(c.env.LOGIN_RATE_LIMITER, c);
  const { email, password } = parseLoginBody(await c.req.json().catch(() => null));

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, user_type, role, name, email, mobile, password_hash, status
     FROM users
     WHERE LOWER(email) = LOWER(?) AND user_type = 'APPLICATION_USER'`,
  )
    .bind(email)
    .first<UserRow>();

  if (!row || !row.password_hash || !row.role) {
    throw new InvalidCredentialsError();
  }
  if (row.status !== 'ACTIVE') {
    throw new InvalidCredentialsError();
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new InvalidCredentialsError();
  }

  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(nowIso(), row.id)
    .run();

  const accessToken = await signApplicationToken(
    { sub: row.id, userId: row.user_id ?? '', role: row.role as 'ADMIN' | 'EMPLOYEE' },
    c.env.JWT_ACCESS_SECRET,
  );

  return c.json(
    ok({
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: APPLICATION_TOKEN_EXPIRES_IN_SECONDS,
      user: {
        id: row.id,
        userId: row.user_id,
        userType: row.user_type,
        role: row.role,
        name: row.name,
        email: row.email,
        mobile: row.mobile,
        status: row.status,
      },
    }),
  );
});

/**
 * POST /api/v1/master-auth/login — MasterAuthService.login() exactly:
 * same generic-failure principle, scoped to userType='MASTER'. No
 * `role` claim on the resulting token (MasterJwtPayload has none) and
 * no `user` object in the response (MasterLoginResult has none either)
 * — both intentional omissions matching the original exactly, not
 * something trimmed for convenience.
 *
 * Phase 35: response gains an explicit `isMaster: true` field so Flutter
 * can read this capability from the backend directly instead of
 * inferring it locally from which login endpoint was called. Purely
 * additive — the MASTER JWT boundary, secret, and payload shape are
 * unchanged, and this flag is never read by any backend authorization
 * check (application middleware still has no MASTER role handling).
 */
authRoutes.post('/master-auth/login', async (c) => {
  await enforceLoginRateLimit(c.env.MASTER_LOGIN_RATE_LIMITER, c);
  const { email, password } = parseLoginBody(await c.req.json().catch(() => null));

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, password_hash, status
     FROM users
     WHERE LOWER(email) = LOWER(?) AND user_type = 'MASTER'`,
  )
    .bind(email)
    .first<UserRow>();

  if (!row || !row.password_hash) {
    throw new InvalidCredentialsError();
  }
  if (row.status !== 'ACTIVE') {
    throw new InvalidCredentialsError();
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new InvalidCredentialsError();
  }

  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(nowIso(), row.id)
    .run();

  const accessToken = await signMasterToken(
    { sub: row.id, userId: row.user_id ?? '' },
    c.env.MASTER_JWT_ACCESS_SECRET,
  );

  return c.json(
    ok({
      accessToken,
      tokenType: 'Bearer' as const,
      tokenScope: 'MASTER' as const,
      isMaster: true as const,
      expiresIn: MASTER_TOKEN_EXPIRES_IN_SECONDS,
    }),
  );
});
