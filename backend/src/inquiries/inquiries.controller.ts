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
  Query,
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
import { AssignInquiryDto } from './dto/assign-inquiry.dto';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQueryDto } from './dto/list-inquiries-query.dto';
import { PublicVisibilityDto } from './dto/public-visibility.dto';
import { UpdateInquiryDto } from './dto/update-inquiry.dto';
import { InquiriesService } from './inquiries.service';

/**
 * Inquiry Management. ADMIN and EMPLOYEE both have full access (same
 * pattern as Customers/Properties/Attachments in Phases 3-5); CUSTOMER
 * can't reach this (no application JWT); MASTER is not granted access —
 * no authoritative document defines master inquiry-management access.
 * Creator/actor identity is always taken from the verified JWT
 * (@CurrentUser()), never from the request body.
 */
@ApiTags('Inquiries')
@Controller('inquiries')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Get()
  async list(@Query() query: ListInquiriesQueryDto) {
    const result = await this.inquiriesService.list(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }

  @Get(':inquiryId')
  async getById(@Param('inquiryId', ParseUUIDPipe) inquiryId: string) {
    const inquiry = await this.inquiriesService.getById(inquiryId);
    return { success: true, data: inquiry };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateInquiryDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const inquiry = await this.inquiriesService.create(dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: inquiry };
  }

  @Patch(':inquiryId')
  async update(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Body() dto: UpdateInquiryDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const inquiry = await this.inquiriesService.update(inquiryId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: inquiry };
  }

  /**
   * ADMIN-only (Phase 18A) — overrides the class-level
   * @Roles('ADMIN','EMPLOYEE') for just this route. See
   * InquiriesService.delete()'s doc comment for the cascade/R2 cleanup
   * behavior.
   */
  @Delete(':inquiryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('ADMIN')
  async remove(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    await this.inquiriesService.delete(inquiryId, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
  }

  @Post(':inquiryId/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const inquiry = await this.inquiriesService.submit(inquiryId, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: inquiry };
  }

  @Post(':inquiryId/assign')
  @HttpCode(HttpStatus.OK)
  async assign(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Body() dto: AssignInquiryDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const inquiry = await this.inquiriesService.assign(inquiryId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: inquiry };
  }

  @Get(':inquiryId/assignments')
  async listAssignments(@Param('inquiryId', ParseUUIDPipe) inquiryId: string) {
    const assignments = await this.inquiriesService.listAssignments(inquiryId);
    return { success: true, data: assignments };
  }

  @Get(':inquiryId/matches')
  async findMatches(@Param('inquiryId', ParseUUIDPipe) inquiryId: string) {
    const matches = await this.inquiriesService.findMatches(inquiryId);
    return { success: true, data: matches };
  }

  @Patch(':inquiryId/public')
  async setPublicVisibility(
    @Param('inquiryId', ParseUUIDPipe) inquiryId: string,
    @Body() dto: PublicVisibilityDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const inquiry = await this.inquiriesService.setPublicVisibility(inquiryId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: inquiry };
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
