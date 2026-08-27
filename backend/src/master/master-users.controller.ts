import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtMasterAuthGuard } from '../auth/guards/jwt-master-auth.guard';
import { MasterJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ListUsersQueryDto } from '../users/dto/list-users-query.dto';
import { UsersService } from '../users/users.service';
import { CreateApplicationUserDto } from './dto/create-application-user.dto';
import { UpdateApplicationUserDto } from './dto/update-application-user.dto';
import { MasterUsersService } from './master-users.service';

/**
 * /api/v1/master/users — per docs/api/openapi.yaml. Requires a
 * master-scoped JWT (JwtMasterAuthGuard) — an application (ADMIN/
 * EMPLOYEE) token cannot pass this guard for the same structural reason
 * it can't pass any other master-scoped route (different signing secret
 * entirely). No RolesGuard: MasterJwtPayload carries no `role` field —
 * there is only one master privilege level, so guard-passing is itself
 * sufficient authorization here, same as MasterAuthController.
 *
 * GET delegates to UsersService.list() (Phase 15A) — the exact same
 * query logic already used by GET /users (the ADMIN/EMPLOYEE-facing
 * assignment picker), just reachable under the master-JWT boundary too,
 * rather than duplicating the query. GET /users itself is untouched.
 */
@ApiBearerAuth('master-jwt')
@ApiTags('Master Management')
@Controller('master/users')
@UseGuards(JwtMasterAuthGuard)
export class MasterUsersController {
  constructor(
    private readonly masterUsersService: MasterUsersService,
    private readonly usersService: UsersService,
  ) {}

  @Get()
  async list(@Query() query: ListUsersQueryDto) {
    const result = await this.usersService.list(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateApplicationUserDto,
    @CurrentUser() master: MasterJwtPayload,
    @Req() req: Request,
  ) {
    const user = await this.masterUsersService.create(dto, {
      userId: master.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: user };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApplicationUserDto,
    @CurrentUser() master: MasterJwtPayload,
    @Req() req: Request,
  ) {
    const user = await this.masterUsersService.update(id, dto, {
      userId: master.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: user };
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
