import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { AttachmentsService } from './attachments.service';
import { CreateAttachmentUploadDto } from './dto/create-attachment-upload.dto';
import { FinalizeAttachmentDto } from './dto/finalize-attachment.dto';
import { ListAttachmentsQueryDto } from './dto/list-attachments-query.dto';

/**
 * Unified attachment storage. ADMIN and EMPLOYEE have full access
 * (matching Customers/Properties in Phases 3–4); CUSTOMER can't reach
 * this (no application JWT); MASTER is not granted access — no
 * authoritative document defines master attachment-management access.
 */
@ApiTags('Attachments')
@Controller('attachments')
@ApiBearerAuth('application-jwt')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post('upload-url')
  async createUploadUrl(
    @Body() dto: CreateAttachmentUploadDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const result = await this.attachmentsService.createUploadUrl(dto, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: result };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async finalize(
    @Body() dto: FinalizeAttachmentDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const attachment = await this.attachmentsService.finalize(dto, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: attachment };
  }

  @Get()
  async list(@Query() query: ListAttachmentsQueryDto) {
    const attachments = await this.attachmentsService.list(query);
    return { success: true, data: attachments };
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    await this.attachmentsService.remove(attachmentId, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
