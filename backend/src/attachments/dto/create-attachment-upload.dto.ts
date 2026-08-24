import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const ATTACHMENT_TYPES = ['PHOTO', 'DOCUMENT', 'RECORDING'] as const;
const DOCUMENT_TYPES = ['SEVEN_TWELVE', 'SALE_DEED', 'PROPERTY_CARD', 'NOC', 'OTHER'] as const;

/**
 * Matches components.schemas.CreateAttachmentUploadRequest in
 * docs/api/openapi.yaml. Relationship rules (propertyId required for
 * PHOTO/DOCUMENT, inquiryId required for RECORDING, documentType required
 * only for DOCUMENT) are enforced in AttachmentsService, not here — they
 * depend on attachmentType's value, which class-validator's per-field
 * decorators can't express well; keeping that logic in one place (the
 * service) avoids duplicating/drifting the rule.
 */
export class CreateAttachmentUploadDto {
  @ApiProperty({ enum: ATTACHMENT_TYPES })
  @IsIn(ATTACHMENT_TYPES)
  attachmentType!: (typeof ATTACHMENT_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  inquiryId?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_TYPES })
  @IsOptional()
  @IsIn(DOCUMENT_TYPES)
  documentType?: (typeof DOCUMENT_TYPES)[number];

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  mimeType!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
