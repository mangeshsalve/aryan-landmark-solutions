import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ListPublicPropertiesQueryDto } from './dto/list-public-properties-query.dto';
import { PropertiesService } from './properties.service';

/**
 * GET /public/properties (Phase 8). Unauthenticated — no guards, matching
 * docs/api/openapi.yaml's /public/properties path, which declares no
 * `security` requirement (unlike every other Inquiries/Properties/
 * Attachments path, which all require applicationBearer). Returns the same
 * `Property` shape and `toPublicProperty` allow-list mapper as the internal
 * endpoint (see property.mapper.ts) — that mapper never included
 * customer/employee/audit/R2 fields to begin with, so no extra field
 * stripping is needed here.
 */
@ApiTags('Public Properties')
@Controller('public/properties')
export class PublicPropertiesController {
  constructor(private readonly propertiesService: PropertiesService) {}

  @Get()
  async list(@Query() query: ListPublicPropertiesQueryDto) {
    const result = await this.propertiesService.listPublic(query);
    return { success: true, data: result.data, pagination: result.pagination };
  }
}
