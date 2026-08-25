import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const INQUIRY_STATUSES = ['NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
const INQUIRY_TYPES = ['BUYER', 'SELLER'] as const;

/**
 * Matches components.schemas.UpdateInquiryRequest in docs/api/openapi.yaml
 * exactly. Every field optional — partial-update semantics: a field
 * omitted from the request body is left untouched by InquiriesService
 * (mapped to `undefined` for Prisma, never coerced to null), so editing
 * an inquiry can never accidentally clear its customer/property/
 * attachment relationships.
 */
export class UpdateInquiryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ enum: INQUIRY_TYPES })
  @IsOptional()
  @IsIn(INQUIRY_TYPES)
  type?: (typeof INQUIRY_TYPES)[number];

  @ApiPropertyOptional({ enum: INQUIRY_PRIORITIES })
  @IsOptional()
  @IsIn(INQUIRY_PRIORITIES)
  priority?: (typeof INQUIRY_PRIORITIES)[number];

  @ApiPropertyOptional({ enum: INQUIRY_STATUSES })
  @IsOptional()
  @IsIn(INQUIRY_STATUSES)
  status?: (typeof INQUIRY_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

  @ApiPropertyOptional({
    description: 'BUYER matching preference — the city the buyer wants to purchase in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  preferredCity?: string;

  @ApiPropertyOptional({
    description: 'BUYER matching preference — the exact pincode the buyer wants to purchase in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  preferredPincode?: string;

  @ApiPropertyOptional({
    description: 'BUYER matching preference — maximum price the buyer is willing to pay.',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBudget?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  handledByUserId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}
