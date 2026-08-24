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

/**
 * Matches components.schemas.CreatePropertyRequest in docs/api/openapi.yaml.
 * Deliberately excludes createdBy/updatedBy/status/id — those are never
 * accepted from the client (status defaults to AVAILABLE at the database
 * level; createdBy/updatedBy are derived from the authenticated JWT in
 * PropertiesService).
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  areaUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  priceUnit?: string;

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
