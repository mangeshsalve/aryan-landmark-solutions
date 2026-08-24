import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const PROPERTY_STATUSES = ['AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE'] as const;
const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'] as const;

/**
 * Matches GET /properties query parameters in docs/api/openapi.yaml:
 * page, pageSize, status, category, city, search. `search` matches
 * against propertyCode, propertyType, and locality/city/address text —
 * a plain contains-match, not a search engine, per this phase's scope.
 */
export class ListPropertiesQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: PROPERTY_STATUSES })
  @IsOptional()
  @IsIn(PROPERTY_STATUSES)
  status?: (typeof PROPERTY_STATUSES)[number];

  @ApiPropertyOptional({ enum: PROPERTY_CATEGORIES })
  @IsOptional()
  @IsIn(PROPERTY_CATEGORIES)
  category?: (typeof PROPERTY_CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ description: 'Matches propertyCode, propertyType, locality, or address' })
  @IsOptional()
  @IsString()
  search?: string;
}
