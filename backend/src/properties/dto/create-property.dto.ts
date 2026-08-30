import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const PROPERTY_CATEGORIES = ['RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL'] as const;
const PROPERTY_AREA_UNITS = ['SQ_FT', 'SQ_YD', 'SQ_M', 'ACRE', 'GUNTHA', 'HECTARE'] as const;

/**
 * Matches components.schemas.CreatePropertyRequest in docs/api/openapi.yaml.
 * Deliberately excludes createdBy/updatedBy/status/id — those are never
 * accepted from the client (status defaults to AVAILABLE at the database
 * level; createdBy/updatedBy are derived from the authenticated JWT in
 * PropertiesService).
 *
 * areaUnit is a controlled list (was free-text before the phase that
 * converted properties.area_unit to a real enum; SQ_YD/SQ_M added later,
 * purely additive — see the migration that added them).
 *
 * priceUnit is deliberately absent (this phase) — this application is
 * India-only, price is always INR; PropertiesService.create() hardcodes
 * it rather than reading it from the request, so it's never client-
 * settable. The database column is untouched (still present, still
 * 'INR' on every row) — only the request contract changed.
 */
export class CreatePropertyDto {
  @ApiPropertyOptional({ description: 'Optional — generated server-side if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  propertyCode?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  propertyType!: string;

  @ApiProperty({ enum: PROPERTY_CATEGORIES })
  @IsIn(PROPERTY_CATEGORIES)
  category!: (typeof PROPERTY_CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  area?: number;

  @ApiPropertyOptional({ enum: PROPERTY_AREA_UNITS })
  @IsOptional()
  @IsIn(PROPERTY_AREA_UNITS)
  areaUnit?: (typeof PROPERTY_AREA_UNITS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  gatNoDetails?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  locality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  pincode?: string;

  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ format: 'uri' })
  @IsOptional()
  @IsUrl()
  mapUrl?: string;
}
