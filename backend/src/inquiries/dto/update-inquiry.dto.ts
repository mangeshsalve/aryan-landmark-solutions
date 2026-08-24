import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const INQUIRY_STATUSES = ['NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

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
