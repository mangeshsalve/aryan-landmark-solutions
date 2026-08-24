import { ApplicationRoleValue, UserStatusValue, UserTypeValue } from '../common/types/domain-enums';

/**
 * Matches components.schemas.User in docs/api/openapi.yaml exactly — an
 * explicit allow-list, not a deny-list: passwordHash is simply never
 * referenced here, so it cannot leak even if a field is added to the
 * users table later without this file being updated.
 */
export interface PublicUser {
  id: string;
  userId: string | null;
  userType: UserTypeValue;
  role: ApplicationRoleValue | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: UserStatusValue;
}

interface UserRow {
  id: string;
  userId: string | null;
  userType: string;
  role: string | null;
  name: string;
  email: string | null;
  mobile: string | null;
  status: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    userId: row.userId,
    userType: row.userType as UserTypeValue,
    role: row.role as ApplicationRoleValue | null,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    status: row.status as UserStatusValue,
  };
}
