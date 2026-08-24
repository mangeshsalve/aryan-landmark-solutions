/**
 * String-literal unions matching the enum values declared in
 * prisma/schema.prisma / docs/database/schema.sql exactly.
 *
 * Used in place of Prisma's generated enum types (e.g. `$Enums.UserType`,
 * `ApplicationRole`) for pure type positions (interfaces, decorator
 * parameter types, DTOs) — not for querying, where the real
 * PrismaClient/generated types are still used directly. This keeps
 * call-site type-checking independent of whether `prisma generate` has
 * run in a given environment, since these are structurally identical to
 * what Prisma generates for the same enum. If a value is ever added to an
 * enum in schema.prisma, update it here too.
 */
export type ApplicationRoleValue = 'ADMIN' | 'EMPLOYEE';
export type UserTypeValue = 'APPLICATION_USER' | 'CUSTOMER' | 'MASTER';
export type UserStatusValue = 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
export type PropertyCategoryValue = 'RESIDENTIAL' | 'INDUSTRIAL' | 'COMMERCIAL' | 'AGRICULTURAL';
export type PropertyStatusValue = 'AVAILABLE' | 'SOLD' | 'ON_HOLD' | 'INACTIVE';
export type AttachmentTypeValue = 'PHOTO' | 'DOCUMENT' | 'RECORDING';
export type DocumentTypeValue = 'SEVEN_TWELVE' | 'SALE_DEED' | 'PROPERTY_CARD' | 'NOC' | 'OTHER';
export type InquiryStatusValue = 'NEW' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type InquiryPriorityValue = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
