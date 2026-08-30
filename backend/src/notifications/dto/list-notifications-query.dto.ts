import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Matches GET /notifications query parameters in docs/api/openapi.yaml:
 * page, pageSize, isRead. Same pagination convention as every other list
 * endpoint (Customers/Properties/Inquiries/Users).
 */
export class ListNotificationsQueryDto {
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

  @ApiPropertyOptional({
    description: 'Filter to only read (true) or only unread (false) notifications.',
  })
  @IsOptional()
  // Query params arrive as strings ("true"/"false"). Two coercion
  // pitfalls stacked here, confirmed by actually reproducing both against
  // the real global ValidationPipe config (transformOptions:
  // { enableImplicitConversion: true }), not assumed:
  //  1. A plain Type(() => Boolean)/JS `Boolean(value)` treats any
  //     non-empty string — including the string "false" — as true.
  //  2. enableImplicitConversion runs its OWN implicit Boolean coercion
  //     (from the reflected `design:type`) BEFORE a @Transform's `value`
  //     is handed to the callback, so a @Transform reading `value` (e.g.
  //     `value === 'false' ? false : ...`) receives the *already*
  //     mis-coerced boolean `true`, not the original string — it never
  //     sees "false" at all, and silently passes the wrong value through.
  // Reading `obj.isRead` (the untouched raw plain-object value) instead
  // of `value` bypasses that implicit pass entirely.
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    if (obj.isRead === undefined) return undefined;
    return obj.isRead === 'true' || obj.isRead === true;
  })
  @IsBoolean()
  isRead?: boolean;
}
