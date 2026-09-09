import bcrypt from 'bcryptjs';

/**
 * Workers-compatible password infrastructure — Step 8.
 *
 * Existing algorithm (src/auth/services/password.service.ts): bcrypt via
 * the `bcryptjs` npm package — already pure JavaScript, no native
 * compilation, work factor 12. This is not a new choice for the Worker
 * side: the SAME package and SAME cost factor are reused here, so hashes
 * produced by the existing NestJS backend and this Worker are directly
 * interchangeable — this file does not introduce any new hashing format.
 *
 * Compatibility with existing stored hashes: bcrypt hashes are
 * self-describing (the algorithm identifier, cost factor, and salt are
 * all encoded in the stored hash string itself, e.g. `$2b$12$...`) — any
 * bcrypt-compatible verifier can check a password against a hash
 * produced by any other bcrypt implementation using the same variant,
 * regardless of what created it. This was directly tested, not assumed —
 * see the Phase 2 report's validation section for a real hash generated
 * once and verified from both bcryptjs call sites.
 */
const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function verifyPassword(plainTextPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}
