import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

const FOLLOW_UP_STATUSES = ['PENDING', 'COMPLETED'] as const;

/**
 * Matches components.schemas.CreateFollowUpRequest in docs/api/openapi.yaml
 * exactly. No inquiryId field — it comes from the route
 * (POST /inquiries/{inquiryId}/follow-ups), never the body. No
 * createdBy/updatedBy — derived from the authenticated JWT in
 * FollowUpsService, never accepted from the client.
 *
 * scheduledAt is a single ISO-8601 date-time, matching every other
 * date+time field in this schema (submittedAt, assignedAt, createdAt).
 * The old web UI shows separate Date/Time fields — combining them into
 * one value before sending is a Flutter-side concern.
 */
export class CreateFollowUpDto {
  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  scheduledAt!: string;

  @ApiPropertyOptional({ enum: FOLLOW_UP_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(FOLLOW_UP_STATUSES)
  status?: (typeof FOLLOW_UP_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  reminderEnabled?: boolean;
}
