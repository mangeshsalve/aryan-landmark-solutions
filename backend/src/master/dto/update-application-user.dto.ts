import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateApplicationUserDto } from './create-application-user.dto';

const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;

/**
 * Matches components.schemas.UpdateApplicationUserRequest in
 * docs/api/openapi.yaml (Phase 15A). Everything from
 * CreateApplicationUserDto except `password` and `userId` — password
 * change isn't part of this phase's confirmed requirements (Master Admin
 * user management: view/create/edit/activate-deactivate/assign role) and
 * userId is a stable business identifier, not something edited casually.
 * `role` is inherited as-is, so it stays restricted to ADMIN/EMPLOYEE —
 * MASTER can never be assigned through this endpoint either.
 *
 * `status` is added here (not on Create — new users always start ACTIVE,
 * the existing DB default) to drive activate/deactivate: reuses the
 * existing ACTIVE/INACTIVE/BLOCKED enum, already checked by
 * ApplicationAuthService.login (`status !== 'ACTIVE'` blocks login) —
 * no new status and no new auth logic needed.
 */
export class UpdateApplicationUserDto extends PartialType(
  OmitType(CreateApplicationUserDto, ['password', 'userId'] as const),
) {
  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: (typeof USER_STATUSES)[number];
}
