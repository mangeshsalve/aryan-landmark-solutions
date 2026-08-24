import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { CreatePropertyDto } from './create-property.dto';

const PROPERTY_STATUSES = ['AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE'] as const;

/**
 * Matches UpdatePropertyRequest in docs/api/openapi.yaml: everything from
 * CreatePropertyDto, all optional, plus status and isPublic. Still
 * excludes createdBy/updatedBy — those are never client-writable, on
 * create or update. isPublic is accepted here at the DTO/validation
 * layer, but PropertiesService.update() rejects it unless the actor is
 * ADMIN (role comes from the JWT, never trusted from the request body).
 */
export class UpdatePropertyDto extends PartialType(CreatePropertyDto) {
  @ApiPropertyOptional({ enum: PROPERTY_STATUSES })
  @IsOptional()
  @IsIn(PROPERTY_STATUSES)
  status?: (typeof PROPERTY_STATUSES)[number];

  @ApiPropertyOptional({ description: 'ADMIN only.' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
