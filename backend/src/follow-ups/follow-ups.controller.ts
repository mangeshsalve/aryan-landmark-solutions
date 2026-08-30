import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../auth/guards/jwt-application-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApplicationJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateFollowUpDto } from './dto/create-follow-up.dto';
import { UpdateFollowUpDto } from './dto/update-follow-up.dto';
import { FollowUpsService } from './follow-ups.service';

/**
 * Nested under an inquiry, matching the existing
 * /inquiries/{inquiryId}/assignments and /inquiries/{inquiryId}/matches
 * pattern. ADMIN and EMPLOYEE both reach every route here
 * (@Roles('ADMIN','EMPLOYEE')); create()/update() additionally require an
 * EMPLOYEE's parent inquiry to be currently assigned to them (Phase 23A —
 * see FollowUpsService's doc comment). list() and delete() remain
 * unrestricted beyond that base role check.
 */
@ApiTags('Follow-ups')
@Controller('inquiries/:inquiryId/follow-ups')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Get()
  async list(@Param('inquiryId', ParseUUIDPipe) inquiryId: string) {
    const followUps = await this.followUpsService.list(inquiryId);
    return { success: true, data: followUps };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Body() dto: CreateFollowUpDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const followUp = await this.followUpsService.create(inquiryId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: followUp };
  }

  @Patch(':followUpId')
  async update(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Param('followUpId', ParseUUIDPipe) followUpId: string,
    @Body() dto: UpdateFollowUpDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const followUp = await this.followUpsService.update(inquiryId, followUpId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: followUp };
  }

  /**
   * ADMIN and EMPLOYEE both allowed (Phase 22B) — no @Roles override,
   * the class-level @Roles('ADMIN','EMPLOYEE') already matches this
   * business decision, consistent with create()/update() above.
   */
  @Delete(':followUpId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Param('followUpId', ParseUUIDPipe) followUpId: string,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    await this.followUpsService.delete(inquiryId, followUpId, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
