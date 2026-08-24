import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/** Matches components.schemas.AssignInquiryRequest in docs/api/openapi.yaml exactly. */
export class AssignInquiryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  assignedToUserId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
