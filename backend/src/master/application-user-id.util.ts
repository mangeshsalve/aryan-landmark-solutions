import { randomBytes } from 'crypto';
import { ApplicationRoleValue } from '../common/types/domain-enums';

/**
 * PLACEHOLDER — no application userId (business identifier, e.g. EMP001)
 * generation format is defined anywhere in the authoritative documents,
 * same situation as propertyCode/inquiryNumber. `userId` is optional in
 * CreateApplicationUserRequest but NOT NULL UNIQUE for APPLICATION_USER
 * (chk_users_identity, schema.sql), so something must generate one when
 * the client doesn't supply it. Flagged for confirmation, not final
 * business logic. Collisions are checked and retried by the caller
 * (MasterUsersService.generateFreeUserId).
 */
export function generateApplicationUserId(role: ApplicationRoleValue): string {
  const prefix = role === 'ADMIN' ? 'ADM' : 'EMP';
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}
