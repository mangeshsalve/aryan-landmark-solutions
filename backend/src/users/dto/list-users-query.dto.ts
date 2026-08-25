import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const APPLICATION_ROLES = ['ADMIN', 'EMPLOYEE'] as const;
const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;

/**
 * Matches GET /users query parameters in docs/api/openapi.yaml exactly:
 * page, pageSize, role, status, search. Same pagination/search
 * conventions as ListCustomersQueryDto.
 */
export class ListUsersQueryDto {
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

  @ApiPropertyOptional({ enum: APPLICATION_ROLES })
  @IsOptional()
  @IsIn(APPLICATION_ROLES)
  role?: (typeof APPLICATION_ROLES)[number];

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: (typeof USER_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Matches against name, mobile, email, or userId' })
  @IsOptional()
  @IsString()
  search?: string;
}
