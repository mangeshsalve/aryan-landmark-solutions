import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

/**
 * bcrypt (via bcryptjs — pure JS, no native compilation) is one of the two
 * production-safe algorithms named in security-architecture.md ("Argon2id
 * or bcrypt"). Work factor 12 is a reasonable current default; centralizing
 * it here means it's a one-line change later if it needs raising.
 */
const SALT_ROUNDS = 12;

@Injectable()
export class PasswordService {
  async hash(plainTextPassword: string): Promise<string> {
    return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
  }

  async verify(plainTextPassword: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(plainTextPassword, passwordHash);
  }
}
