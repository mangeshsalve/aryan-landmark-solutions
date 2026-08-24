import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Matches components.schemas.PublicVisibilityRequest in docs/api/openapi.yaml exactly. */
export class PublicVisibilityDto {
  @ApiProperty()
  @IsBoolean()
  isPublic!: boolean;
}
