import { ApplicationRoleValue } from '../../common/types/domain-enums';

/**
 * Two structurally distinct token shapes, each signed with its own secret
 * (see TokenService). `tokenType` is checked defensively by each guard in
 * addition to the secret mismatch already rejecting the wrong token type —
 * defense in depth against any future secret-configuration mistake.
 */
export interface ApplicationJwtPayload {
  tokenType: 'APPLICATION';
  sub: string; // users.id (UUID)
  userId: string; // users.user_id (business identifier, e.g. EMP001)
  role: ApplicationRoleValue; // ADMIN | EMPLOYEE
}

export interface MasterJwtPayload {
  tokenType: 'MASTER';
  sub: string; // users.id (UUID)
  userId: string;
}

export type AnyJwtPayload = ApplicationJwtPayload | MasterJwtPayload;
