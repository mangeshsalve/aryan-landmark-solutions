import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from './create-customer.dto';

/**
 * Same whitelist as CreateCustomerDto, every field optional for PATCH
 * semantics. Still excludes userType, role, password/passwordHash,
 * createdBy, and updatedBy — PartialType only relaxes required-ness, it
 * doesn't add fields.
 */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
