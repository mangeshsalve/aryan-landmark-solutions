import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'] as const;

/**
 * Matches GET /public/properties query parameters in docs/api/openapi.yaml
 * exactly: page, pageSize, category, city. No `status` or `search` — the
 * public contract doesn't define them (status is implicit — see
 * PropertiesService.listPublic's doc comment).
 */
export class ListPublicPropertiesQueryDto {
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

  @ApiPropertyOptional({ enum: PROPERTY_CATEGORIES })
  @IsOptional()
  @IsIn(PROPERTY_CATEGORIES)
  category?: (typeof PROPERTY_CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}
