import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

const INQUIRY_STATUSES = ['NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
const INQUIRY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

/**
 * Matches GET /inquiries query parameters in docs/api/openapi.yaml: page,
 * pageSize, status, priority, assignedToUserId, handledByUserId,
 * customerId, propertyId.
 */
export class ListInquiriesQueryDto {
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

  @ApiPropertyOptional({ enum: INQUIRY_STATUSES })
  @IsOptional()
  @IsIn(INQUIRY_STATUSES)
  status?: (typeof INQUIRY_STATUSES)[number];

  @ApiPropertyOptional({ enum: INQUIRY_PRIORITIES })
  @IsOptional()
  @IsIn(INQUIRY_PRIORITIES)
  priority?: (typeof INQUIRY_PRIORITIES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  handledByUserId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}
