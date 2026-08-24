import { UserStatusValue, UserTypeValue } from '../common/types/domain-enums';

/**
 * Explicit allow-list mapper, not a deny-list: passwordHash is simply
 * never referenced here, so it cannot leak even if a field is added to
 * the users table later without this file being updated.
 */
export interface PublicCustomer {
  id: string;
  userType: UserTypeValue;
  name: string;
  email: string | null;
  mobile: string | null;
  alternateMobile: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  status: UserStatusValue;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomerRow {
  id: string;
  userType: string;
  name: string;
  email: string | null;
  mobile: string | null;
  alternateMobile: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicCustomer(user: CustomerRow): PublicCustomer {
  return {
    id: user.id,
    userType: user.userType as UserTypeValue,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    alternateMobile: user.alternateMobile,
    address: user.address,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
    status: user.status as UserStatusValue,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
