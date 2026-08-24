import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ enum: INQUIRY_PRIORITIES })
  @IsOptional()
  @IsIn(INQUIRY_PRIORITIES)
  priority?: (typeof INQUIRY_PRIORITIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

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
