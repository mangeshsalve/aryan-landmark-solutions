import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreatePropertyDto } from './create-property.dto';

const PROPERTY_STATUSES = ['AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE'] as const;

/**
 * Matches UpdatePropertyRequest in docs/api/openapi.yaml: everything from
 * CreatePropertyDto, all optional, plus status. Still excludes
 * createdBy/updatedBy — those are never client-writable, on create or
 * update.
 */
export class UpdatePropertyDto extends PartialType(CreatePropertyDto) {
  @ApiPropertyOptional({ enum: PROPERTY_STATUSES })
  @IsOptional()
  @IsIn(PROPERTY_STATUSES)
  status?: (typeof PROPERTY_STATUSES)[number];
}
