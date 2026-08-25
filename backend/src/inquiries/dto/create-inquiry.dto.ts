import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const INQUIRY_TYPES = ['BUYER', 'SELLER'] as const;

/**
 * Matches components.schemas.CreateInquiryRequest in docs/api/openapi.yaml
 * exactly. No `status` field — status always starts at the database
 * default (NEW). No `role`/`createdBy`/`handledByUser` actor fields —
 * those are derived from the authenticated JWT in InquiriesService, never
 * accepted from the client (the global ValidationPipe's
 * forbidNonWhitelisted rejects an attempt to send them).
 */
export class CreateInquiryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  propertyId!: string;

  @ApiPropertyOptional({ enum: INQUIRY_TYPES })
  @IsOptional()
  @IsIn(INQUIRY_TYPES)
  type?: (typeof INQUIRY_TYPES)[number];

  @ApiPropertyOptional({ enum: INQUIRY_PRIORITIES })
  @IsOptional()
  @IsIn(INQUIRY_PRIORITIES)
  priority?: (typeof INQUIRY_PRIORITIES)[number];

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

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  handledByUserId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}
