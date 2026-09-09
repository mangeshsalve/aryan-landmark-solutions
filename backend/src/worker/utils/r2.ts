import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../types/bindings';

/**
 * Worker-side storage abstraction mirroring src/storage/storage.service.ts
 * (StorageService) and src/storage/cloudflare-r2-storage.service.ts
 * (CloudflareR2StorageService) field-for-field: same UploadAuthorization/
 * ObjectVerificationResult shapes, same 900s presigned-URL expiry, same
 * isConfigured() gate before any network call, same "never falls back to
 * another provider" behavior (StorageNotConfiguredError instead).
 *
 * Uses aws4fetch, not the AWS SDK v3 the real backend uses — a Worker
 * runtime compatibility swap, not a behavior change (R2 is S3-compatible;
 * both do SigV4 signing against the same endpoint). This specific
 * technique (AwsClient, signQuery presigned PUT, HEAD-based existence
 * check) was already proven against real deployed R2 in the earlier
 * backend-d1-test POC (see src/utils/r2.ts there) — reused here as
 * "a previously proven technical pattern" per this phase's instructions,
 * not as a source of business behavior (which comes only from the real
 * NestJS storage/attachments code).
 *
 * One deliberate improvement over the POC: the presigned PUT here signs
 * the Content-Type header (via aws4fetch's signQuery, which folds
 * assigned headers into the signed query string), so the upload URL only
 * validates for a PUT that actually sends the same Content-Type the
 * client declared when requesting it — closer to what
 * CloudflareR2StorageService's PutObjectCommand({ContentType, ...})
 * does. Content-Length is not signed (neither implementation signs it;
 * S3-compatible presigned URLs don't require it as a signed header).
 */

export interface UploadAuthorization {
  uploadUrl: string;
  r2ObjectKey: string;
  expiresIn: number;
}

export interface DownloadAuthorization {
  downloadUrl: string;
  expiresIn: number;
}

export interface ObjectVerificationResult {
  exists: boolean;
  sizeBytes?: number;
}

const UPLOAD_URL_EXPIRES_IN_SECONDS = 900; // matches CloudflareR2StorageService exactly

// Phase 27 — deliberately much shorter than the upload URL's 900s: this
// authorizes read access to a file that may be sensitive (a call
// recording, a property document, a photo), handed to a client that will
// use it within seconds of asking (an image tag loading, a tap-to-open
// action), never stored or reused across sessions. 300s comfortably
// covers a single viewing/loading window without leaving a long-lived
// unauthenticated link floating around in memory, a cache, or a browser
// history entry.
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 300;

export function isR2Configured(env: Bindings): boolean {
  return Boolean(
    env.CLOUDFLARE_R2_ACCOUNT_ID &&
    env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    env.CLOUDFLARE_R2_SECRET_ACCESS_KEY &&
    env.CLOUDFLARE_R2_BUCKET,
  );
}

export function getBucketName(env: Bindings): string | undefined {
  return env.CLOUDFLARE_R2_BUCKET;
}

export function getPublicUrl(env: Bindings, objectKey: string): string | undefined {
  if (!env.CLOUDFLARE_R2_PUBLIC_BASE_URL) return undefined;
  return `${env.CLOUDFLARE_R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`;
}

function client(env: Bindings): AwsClient {
  // Callers are required to check isR2Configured(env) first — every
  // function below does — so these `!` assertions reflect that checked
  // invariant, not an unchecked assumption.
  return new AwsClient({
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });
}

function endpoint(env: Bindings, objectKey: string): string {
  return `https://${env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.CLOUDFLARE_R2_BUCKET}/${objectKey}`;
}

export async function createUploadAuthorization(
  env: Bindings,
  params: { objectKey: string; contentType: string },
): Promise<UploadAuthorization> {
  const url = new URL(endpoint(env, params.objectKey));
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_EXPIRES_IN_SECONDS));
  const signed = await client(env).sign(
    new Request(url, { method: 'PUT', headers: { 'content-type': params.contentType } }),
    { aws: { signQuery: true } },
  );
  return {
    uploadUrl: signed.url,
    r2ObjectKey: params.objectKey,
    expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
  };
}

/**
 * Phase 27 — the read-side counterpart to createUploadAuthorization
 * above: same signQuery presigned-URL technique, GET instead of PUT, no
 * Content-Type to sign (a GET has no request body). The bucket stays
 * private (no r2.dev, no public base URL, no change to isR2Configured's
 * gate) — this is the only way a client obtains a working URL for an
 * object, and it's always short-lived and freshly minted per request,
 * never the same value twice. Callers are responsible for resolving
 * `objectKey` from a trusted source (the attachment's own stored
 * `r2_object_key`) before calling this — this function signs whatever
 * key it's given, the same "caller already validated" contract every
 * other function in this file has.
 */
export async function createDownloadAuthorization(
  env: Bindings,
  objectKey: string,
): Promise<DownloadAuthorization> {
  const url = new URL(endpoint(env, objectKey));
  url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_URL_EXPIRES_IN_SECONDS));
  const signed = await client(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return {
    downloadUrl: signed.url,
    expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  };
}

/**
 * Matches CloudflareR2StorageService.verifyObject() exactly: any failure
 * to confirm existence (network error, 404, etc.) resolves to
 * `{ exists: false }` rather than throwing — the caller (finalize) is
 * responsible for turning that into StorageFinalizationFailedException.
 */
export async function verifyObject(
  env: Bindings,
  objectKey: string,
): Promise<ObjectVerificationResult> {
  try {
    const response = await client(env).fetch(endpoint(env, objectKey), { method: 'HEAD' });
    if (!response.ok) return { exists: false };
    const len = response.headers.get('content-length');
    return { exists: true, sizeBytes: len ? Number(len) : undefined };
  } catch {
    return { exists: false };
  }
}

export async function deleteObject(env: Bindings, objectKey: string): Promise<void> {
  await client(env).fetch(endpoint(env, objectKey), { method: 'DELETE' });
}
