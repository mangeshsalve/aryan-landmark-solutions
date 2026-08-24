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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../auth/guards/jwt-application-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApplicationJwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';
import type { Request } from 'express';

/**
 * Customer Master Data. ADMIN and EMPLOYEE both have full create/read/
 * update access (per this phase's business rule); CUSTOMER can never
 * reach this at all (customers don't get an application JWT — they can't
 * log in); MASTER is not granted access here since no authoritative
 * document defines master customer-management access beyond
 * POST /master/customers, which this module doesn't touch or replace.
 */
@ApiTags('Customers')
@Controller('customers')
@UseGuards(JwtApplicationAuthGuard, RolesGuard)
@Roles('ADMIN', 'EMPLOYEE')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async list(@Query() query: ListCustomersQueryDto) {
    const result = await this.customersService.list(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    const customer = await this.customersService.getById(id);
    return { success: true, data: customer };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const customer = await this.customersService.create(dto, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: customer };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: ApplicationJwtPayload,
    @Req() req: Request,
  ) {
    const customer = await this.customersService.update(id, dto, {
      userId: user.sub,
      ipAddress: req.ip,
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });
    return { success: true, data: customer };
  }
}

function normalizeUserAgent(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
