import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../auth/guards/jwt-application-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UsersService } from './users.service';

/**
 * GET /api/v1/users — per docs/api/openapi.yaml. ADMIN and EMPLOYEE only
 * (same authorization pattern as Customers/Properties/Inquiries);
 * CUSTOMER can't reach this (no application JWT); MASTER auth is not
 * accepted here (JwtApplicationAuthGuard, not JwtMasterAuthGuard).
 */
@ApiTags('Users')
@Controller('users')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async list(@Query() query: ListUsersQueryDto) {
    const result = await this.usersService.list(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }
}
