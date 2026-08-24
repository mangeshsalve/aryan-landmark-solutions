import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtMasterAuthGuard } from '../auth/guards/jwt-master-auth.guard';
import { MasterJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateApplicationUserDto } from './dto/create-application-user.dto';
import { MasterUsersService } from './master-users.service';

/**
 * POST /api/v1/master/users — per docs/api/openapi.yaml. Requires a
 * master-scoped JWT (JwtMasterAuthGuard) — an application (ADMIN/
 * EMPLOYEE) token cannot pass this guard for the same structural reason
 * it can't pass any other master-scoped route (different signing secret
 * entirely). No RolesGuard: MasterJwtPayload carries no `role` field —
 * there is only one master privilege level, so guard-passing is itself
 * sufficient authorization here, same as MasterAuthController.
 */
@ApiTags('Master Management')
@Controller('master/users')
@UseGuards(JwtMasterAuthGuard)
export class MasterUsersController {
  constructor(private readonly masterUsersService: MasterUsersService) {}

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
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
