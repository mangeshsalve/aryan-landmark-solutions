import { SignJWT, jwtVerify } from 'jose';
import type { ApplicationJwtPayload, MasterJwtPayload } from '../types/bindings';

/**
 * Workers-compatible JWT infrastructure — Step 7.
 *
 * Library choice: `jose`. It signs/verifies using the Web Crypto API
 * (crypto.subtle) natively — no Node.js `crypto` module, no
 * nodejs_compat flag needed, unlike the NestJS side's @nestjs/jwt (which
 * wraps the Node-native `jsonwebtoken` package). This was already
 * validated end-to-end in the POC (backend-d1-test) against real
 * deployed Workers, including real login flows — reused here as a
 * confirmed-working choice, not a fresh guess.
 *
 * Claims and algorithm match backend/src/auth/services/token.service.ts
 * and backend/src/auth/interfaces/jwt-payload.interface.ts exactly:
 * HS256, tokenType/sub/userId(/role) claims. A token signed by this file
 * and one signed by the existing NestJS TokenService are byte-for-byte
 * interchangeable as long as both sides are given the same secret — this
 * is what makes a later user-data migration to D1 not also require
 * re-issuing every session.
 *
 * This file only builds the primitives — no login route exists yet
 * (Step 7 explicitly excludes migrating login routes).
 *
 * Phase 35: APPLICATION_TOKEN_EXPIRES_IN_SECONDS raised from 3600s to 30
 * days — the approved minimum change for "stay logged in until logout or
 * deactivation" (no refresh-token machinery introduced; session end is
 * now enforced by requireApplicationAuth's live status check — see
 * middleware/auth.ts — not by short expiry). MASTER's lifetime is
 * unchanged; nothing about the current MASTER implementation requires
 * extending it.
 */

const APPLICATION_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MASTER_TOKEN_EXPIRES_IN_SECONDS = 3600;

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signApplicationToken(
  payload: Omit<ApplicationJwtPayload, 'tokenType'>,
  secret: string,
): Promise<string> {
  return new SignJWT({ ...payload, tokenType: 'APPLICATION' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${APPLICATION_TOKEN_EXPIRES_IN_SECONDS}s`)
    .sign(encodeSecret(secret));
}

export async function signMasterToken(
  payload: Omit<MasterJwtPayload, 'tokenType'>,
  secret: string,
): Promise<string> {
  return new SignJWT({ ...payload, tokenType: 'MASTER' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MASTER_TOKEN_EXPIRES_IN_SECONDS}s`)
    .sign(encodeSecret(secret));
}

/**
 * Verifies against JWT_ACCESS_SECRET specifically and defensively checks
 * tokenType === 'APPLICATION' — the same two-layer boundary the NestJS
 * TokenService.verifyApplicationToken()/JwtApplicationAuthGuard use: a
 * master token is rejected structurally (wrong secret, signature check
 * fails before tokenType is ever read), and the tokenType check is
 * defense-in-depth against a future secret-configuration mistake, not
 * the primary guarantee.
 */
export async function verifyApplicationToken(
  token: string,
  secret: string,
): Promise<ApplicationJwtPayload> {
  const { payload } = await jwtVerify(token, encodeSecret(secret));
  if (payload.tokenType !== 'APPLICATION') {
    throw new Error('Not an application token');
  }
  return payload as unknown as ApplicationJwtPayload;
}

/** Same two-layer boundary as verifyApplicationToken, for MASTER_JWT_ACCESS_SECRET. */
export async function verifyMasterToken(token: string, secret: string): Promise<MasterJwtPayload> {
  const { payload } = await jwtVerify(token, encodeSecret(secret));
  if (payload.tokenType !== 'MASTER') {
    throw new Error('Not a master token');
  }
  return payload as unknown as MasterJwtPayload;
}
