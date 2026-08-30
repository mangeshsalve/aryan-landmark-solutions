import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../auth/guards/jwt-application-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListTodayFollowUpsQueryDto } from './dto/list-today-follow-ups-query.dto';
import { FollowUpsService } from './follow-ups.service';

/**
 * GET /follow-ups/today — the dashboard's Today's Follow-ups section
 * (Phase 16A Part 6). Split into its own controller rather than folded
 * into FollowUpsController, same reasoning as
 * PropertiesController/PublicPropertiesController: a different route
 * prefix (not nested under one inquiry) sharing one service.
 */
@ApiTags('Follow-ups')
@Controller('follow-ups')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class TodayFollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Get('today')
  async listToday(@Query() query: ListTodayFollowUpsQueryDto) {
    const followUps = await this.followUpsService.listToday(query);
    return { success: true, data: followUps };
  }
}
