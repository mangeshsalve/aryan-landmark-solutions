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
import { ApiTags } from '@nestjs/swagger';
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
