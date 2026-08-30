import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Matches components.schemas.UpdateNotificationRequest in
 * docs/api/openapi.yaml. The only supported change is marking a
 * notification read — `isRead: true`. Accepting `isRead: false` too
 * (rather than a one-way "mark read" action) costs nothing and lets a
 * client undo an accidental mark-as-read.
 */
export class UpdateNotificationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}
