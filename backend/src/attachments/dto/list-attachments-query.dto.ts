import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

const ATTACHMENT_TYPES = ['PHOTO', 'DOCUMENT', 'RECORDING'] as const;

/**
 * Matches GET /attachments query parameters in docs/api/openapi.yaml:
 * propertyId, inquiryId, attachmentType. No page/pageSize —
 * AttachmentListResponse has no `pagination` field, unlike the
 * customers/properties list responses, so this deliberately doesn't add
 * one.
 */
export class ListAttachmentsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  inquiryId?: string;

  @ApiPropertyOptional({ enum: ATTACHMENT_TYPES })
  @IsOptional()
  @IsIn(ATTACHMENT_TYPES)
  attachmentType?: (typeof ATTACHMENT_TYPES)[number];
}
