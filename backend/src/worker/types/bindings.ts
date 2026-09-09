// Cloudflare bindings + secrets for the Worker runtime. Deliberately
// defined independently from the NestJS side (src/config/, src/auth/
// interfaces/) rather than imported across runtimes — the Worker bundle
// and the Nest/Prisma compiled output are two separate build targets
// that happen to coexist in this repo during migration, and importing
// across that boundary would create a coupling neither side needs.
//
// Field names for the two JWT secrets and the five R2 variables match
// backend/src/config/env.validation.ts exactly, so the same secret
// values can be reused verbatim once Phase 3+ wires real routes to them
// — nothing here invents a new naming convention.
export type Bindings = {
  DB: D1Database;
  JWT_ACCESS_SECRET: string;
  MASTER_JWT_ACCESS_SECRET: string;
  // R2 — type-only for now (Step 4): these five names match
  // env.validation.ts's CLOUDFLARE_R2_* variables exactly. No attachment
  // route reads them in Phase 2; they're declared so Phase 3+ doesn't
  // need to touch this file again. Same S3-compatible-credentials
  // approach as the real backend (CloudflareR2StorageService) and the
  // POC (aws4fetch) — not a native Cloudflare R2Bucket binding, since
  // neither existing implementation uses one.
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID?: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_R2_BUCKET?: string;
  CLOUDFLARE_R2_PUBLIC_BASE_URL?: string;
  // Matches env.validation.ts's ATTACHMENT_MAX_FILE_SIZE_BYTES exactly
  // (optional, same 26214400/25MB default applied in routes/attachments.ts
  // — see configuration.ts). Workers env vars are always strings, parsed
  // at the point of use.
  ATTACHMENT_MAX_FILE_SIZE_BYTES?: string;
  // Phase 36 — Cloudflare's native Workers Rate Limiting bindings (see
  // wrangler.production.jsonc's `ratelimits` array and wrangler.jsonc's
  // local-dev equivalent). `RateLimit` is a global ambient type from
  // @cloudflare/workers-types (already a devDependency — no import
  // needed here, same as D1Database above). Two independent instances,
  // one per login boundary, so an application-login attacker can never
  // exhaust the MASTER login budget or vice versa — see routes/auth.ts.
  LOGIN_RATE_LIMITER: RateLimit;
  MASTER_LOGIN_RATE_LIMITER: RateLimit;
  // Phase 45B — dedicated limiter for the unauthenticated public inquiry
  // submission endpoints (routes/public-inquiries.ts). Independent from
  // the two login limiters above so a burst of inquiry submissions can
  // never exhaust either login boundary's budget, or vice versa.
  PUBLIC_INQUIRY_RATE_LIMITER: RateLimit;
  // Phase 41C — Firebase Cloud Messaging (HTTP v1) push notifications.
  // Optional, same reasoning as the CLOUDFLARE_R2_* variables above: a
  // Worker started without them must still boot and serve every
  // non-push route normally (utils/fcm.ts throws a clear, caught-and-
  // logged-only error at send time if any is missing, never at startup).
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_EMAIL?: string;
  FCM_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
};

// Values middleware/auth.ts attaches to the request context for
// downstream route handlers — populated once a token verifies.
export type Variables = {
  applicationUser?: ApplicationJwtPayload;
  masterUser?: MasterJwtPayload;
  requestId?: string;
};

export type ApplicationRole = 'ADMIN' | 'EMPLOYEE';

// Mirrors backend/src/auth/interfaces/jwt-payload.interface.ts field for
// field, including the `tokenType` defense-in-depth discriminant — a
// token signed by this Worker's utils/jwt.ts and one signed by the
// existing NestJS TokenService are claim-for-claim interchangeable.
export interface ApplicationJwtPayload {
  tokenType: 'APPLICATION';
  sub: string; // users.id (UUID)
  userId: string; // users.user_id (business identifier, e.g. EMP001)
  role: ApplicationRole;
}

export interface MasterJwtPayload {
  tokenType: 'MASTER';
  sub: string; // users.id (UUID)
  userId: string;
}

export type AnyJwtPayload = ApplicationJwtPayload | MasterJwtPayload;

export type AppEnv = { Bindings: Bindings; Variables: Variables };
