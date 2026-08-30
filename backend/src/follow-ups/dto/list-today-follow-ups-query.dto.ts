import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const FOLLOW_UP_STATUSES = ['PENDING', 'COMPLETED'] as const;

/**
 * Matches GET /follow-ups/today query parameters in
 * docs/api/openapi.yaml: an optional status filter. No page/pageSize —
 * "today" is already a small, naturally bounded result set (see
 * FollowUpsService.listToday's doc comment), unlike the paginated
 * inquiry/customer/property/user lists.
 */
export class ListTodayFollowUpsQueryDto {
  @ApiPropertyOptional({ enum: FOLLOW_UP_STATUSES })
  @IsOptional()
  @IsIn(FOLLOW_UP_STATUSES)
  status?: (typeof FOLLOW_UP_STATUSES)[number];
}
