import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CreateAttachmentUploadDto } from './create-attachment-upload.dto';

/**
 * Matches components.schemas.FinalizeAttachmentRequest — everything from
 * CreateAttachmentUploadDto plus the r2ObjectKey the client got back from
 * POST /attachments/upload-url. This key is never trusted at face value:
 * AttachmentsService.finalize() checks it matches the prefix pattern this
 * backend would have generated (see object-key.util.ts) and, when R2 is
 * configured, verifies the object actually exists before creating any
 * metadata row.
 */
export class FinalizeAttachmentDto extends CreateAttachmentUploadDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  r2ObjectKey!: string;
}
