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
import { CreatePropertyDto } from './dto/create-property.dto';
import { ListPropertiesQueryDto } from './dto/list-properties-query.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import { PropertiesService } from './properties.service';

/**
 * Property Master Data. ADMIN and EMPLOYEE have full create/read/update
 * access; CUSTOMER can't reach this (no application JWT); MASTER is not
 * granted access here — no authoritative document defines master
 * property-management access.
 */
@ApiTags('Properties')
@Controller('properties')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class PropertiesController {
  constructor(private readonly propertiesService: PropertiesService) {}

  @Get()
  async list(@Query() query: ListPropertiesQueryDto) {
    const result = await this.propertiesService.list(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }

  @Get(':propertyId')
  async getById(@Param('propertyId', ParseUUIDPipe) propertyId: string) {
    const property = await this.propertiesService.getById(propertyId);
    return { success: true, data: property };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreatePropertyDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const property = await this.propertiesService.create(dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: property };
  }

  @Patch(':propertyId')
  async update(
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: UpdatePropertyDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const property = await this.propertiesService.update(propertyId, dto, {
      userId: user.sub,
      role: user.role,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: property };
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
