import { SignJWT, importPKCS8 } from 'jose';
import type { Bindings } from '../types/bindings';

/**
 * Phase 41C — Firebase Cloud Messaging (HTTP v1) push delivery, called
 * only from routes/inquiries.ts's createInquiryAssignedNotification
 * after the existing `notifications` row has already been written. This
 * file never touches that table and is not itself a notification system
 * — it is a best-effort delivery mechanism layered on top of the
 * existing, unchanged source of truth.
 *
 * Uses `jose` (already a dependency — see utils/jwt.ts) rather than the
 * Firebase Admin SDK: Admin SDK is Node-native and unusable in a Workers
 * isolate without nodejs_compat shims this project doesn't otherwise
 * need. `jose` signs the service-account JWT with the Web Crypto API
 * directly, exactly like the existing application/master JWT
 * infrastructure.
 *
 * No queue, no separate service: every send is a direct two-step fetch
 * (Google OAuth2 token exchange, then the FCM v1 REST call) from within
 * the same Worker invocation that created the notification, guarded by
 * the caller's own try/catch so a failure here can never fail the
 * inquiry/notification operation it was triggered by.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS = 60;

export interface FcmSendInput {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export type FcmSendResult =
  | { outcome: 'SENT' }
  | { outcome: 'INVALID_TOKEN'; reason: string }
  | { outcome: 'TEMPORARY_FAILURE'; reason: string };

/** Thrown when FCM_PROJECT_ID/FCM_SERVICE_ACCOUNT_EMAIL/FCM_SERVICE_ACCOUNT_PRIVATE_KEY are not all configured — caught by the caller, never allowed to propagate as an unhandled rejection. */
export class FcmNotConfiguredError extends Error {
  constructor() {
    super(
      'FCM is not configured. Set FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_EMAIL, and FCM_SERVICE_ACCOUNT_PRIVATE_KEY.',
    );
  }
}

/** Lets a caller with multiple tokens to send to (e.g. one user's several devices) check once, up front, rather than hitting FcmNotConfiguredError once per token. */
export function isFcmConfigured(env: Bindings): boolean {
  return Boolean(
    env.FCM_PROJECT_ID && env.FCM_SERVICE_ACCOUNT_EMAIL && env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY,
  );
}

/**
 * Cloudflare Workers isolates are not guaranteed to persist between
 * requests (per this phase's explicit instruction), so this cache is
 * purely a best-effort optimization within a single warm isolate's
 * lifetime — a cold isolate simply re-fetches a token on its first send,
 * exactly as if no cache existed. Never persisted to D1/KV; an access
 * token is exactly as sensitive as the credentials it was minted from.
 */
let cachedAccessToken: { accessToken: string; expiresAtEpochSeconds: number } | null = null;

function normalizePrivateKey(rawKey: string): string {
  // Cloudflare secrets are single-line; a PEM private key's real
  // newlines are almost always supplied as literal "\n" escape
  // sequences and must be restored before jose can parse it as PKCS8.
  // A key already containing real newlines (already correctly escaped
  // by whatever set the secret) is left untouched by this replace.
  return rawKey.replace(/\\n/g, '\n');
}

async function fetchGoogleAccessToken(env: Bindings): Promise<string> {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_EMAIL || !env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new FcmNotConfiguredError();
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAtEpochSeconds > now) {
    return cachedAccessToken.accessToken;
  }

  const privateKey = await importPKCS8(
    normalizePrivateKey(env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY),
    'RS256',
  );

  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.FCM_SERVICE_ACCOUNT_EMAIL)
    .setSubject(env.FCM_SERVICE_ACCOUNT_EMAIL)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    // Read the body once, but surface only Google's short top-level
    // OAuth2 "error" category (e.g. "invalid_grant") — never
    // error_description or the raw body, which can otherwise echo back
    // request parameters and must never end up in logs alongside a
    // near-miss of the private key itself.
    const errorBody = await response.json().catch(() => null);
    const errorCategory =
      errorBody !== null &&
      typeof errorBody === 'object' &&
      typeof (errorBody as { error?: unknown }).error === 'string'
        ? (errorBody as { error: string }).error
        : 'unknown';
    throw new Error(
      `Google OAuth2 token exchange failed: HTTP ${response.status}, error=${errorCategory}`,
    );
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    accessToken: body.access_token,
    expiresAtEpochSeconds: now + body.expires_in - ACCESS_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS,
  };
  return body.access_token;
}

/**
 * FCM v1's error envelope for a permanently-dead registration token
 * (app uninstalled, token rotated out from under us, etc.) — see
 * https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode.
 * Only this specific, well-documented shape is treated as "permanently
 * invalid, deactivate it"; every other 4xx/5xx (bad auth, quota,
 * transient backend errors, a temporarily malformed payload) is treated
 * as a transient failure per this phase's explicit "don't treat every
 * non-2xx as a dead token" instruction.
 */
function isPermanentlyInvalidTokenError(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (
        typeof detail === 'object' &&
        detail !== null &&
        (detail as { errorCode?: unknown }).errorCode === 'UNREGISTERED'
      ) {
        return true;
      }
    }
  }
  return (error as { status?: unknown }).status === 'NOT_FOUND';
}

/** Sends a single FCM v1 push. Never throws for an ordinary delivery failure — the caller only needs to branch on `outcome`. Throws only for FcmNotConfiguredError (missing secrets) and genuinely unexpected network/parse errors, both of which the caller wraps in its own try/catch. */
export async function sendFcmPush(env: Bindings, input: FcmSendInput): Promise<FcmSendResult> {
  const accessToken = await fetchGoogleAccessToken(env);

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: input.token,
          notification: {
            title: input.title,
            body: input.body,
          },
          data: input.data,
        },
      }),
    },
  );

  if (response.ok) {
    return { outcome: 'SENT' };
  }

  const responseBody = await response.json().catch(() => null);
  if (isPermanentlyInvalidTokenError(response.status, responseBody)) {
    return { outcome: 'INVALID_TOKEN', reason: `HTTP ${response.status}: token unregistered` };
  }
  return { outcome: 'TEMPORARY_FAILURE', reason: `HTTP ${response.status}` };
}
