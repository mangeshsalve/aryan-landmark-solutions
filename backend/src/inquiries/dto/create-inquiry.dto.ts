import { ApiPropertyOptional } from '@nestjs/swagger';
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
 *
 * Phase 13B: customerId/propertyId are both optional — an ADMIN taking a
 * call can create a lightweight inquiry (customerId=NULL, propertyId=
 * NULL, type=NULL, status=NEW) before either master record exists, then
 * attach a recording/photos/documents against the inquiryId and assign an
 * EMPLOYEE, who identifies/creates the customer and property later via
 * PATCH /inquiries/{id}.
 */
export class CreateInquiryDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

  @ApiPropertyOptional({
    description:
      'Unified location field (this phase), used by both BUYER and SELLER. For a SELLER ' +
      "inquiry with propertyId set, this is ignored and overridden by the linked property's " +
      'own city — see InquiriesService.create() for the sync rule.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    description: 'Unified location field (this phase). Same SELLER-sync override rule as city.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({
    description: 'Unified location field (this phase). Same SELLER-sync override rule as city.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  pincode?: string;

  @ApiPropertyOptional({
    description:
      'Locality/area text (this phase) — the fuzzy-matching signal alongside city. Same ' +
      'SELLER-sync override rule as city (synced from Property.locality, never Property.address).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  locality?: string;

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
