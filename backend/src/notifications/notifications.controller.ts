import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../auth/guards/jwt-application-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApplicationJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { NotificationsService } from './notifications.service';

/**
 * GET/PATCH only — no POST. Notifications are always system-generated as
 * a side effect of a real business action, never created directly by a
 * client (see NotificationsService's doc comment). Every operation is
 * implicitly scoped to the caller's own notifications via @CurrentUser();
 * there is no per-notification ownership check to add beyond that, and
 * no reason to restrict this to one role — any authenticated ADMIN or
 * EMPLOYEE can have notifications and read their own.
 */
@ApiTags('Notifications')
@Controller('notifications')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(
    @Query() query: ListNotificationsQueryDto,
    @CurrentUser() user: ApplicationJwtPayload,
  ) {
    const result = await this.notificationsService.list(user.sub, query);
    return { success: true, data: result.data, pagination: result.pagination };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotificationDto,
    @CurrentUser() user: ApplicationJwtPayload,
  ) {
    const notification = await this.notificationsService.update(user.sub, id, dto);
    return { success: true, data: notification };
  }
}
