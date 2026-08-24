import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

/**
 * GET /api/v1/health — per docs/api/openapi.yaml.
 *
 * Verifies the process is up AND the database is reachable, since a
 * process that's alive but can't reach PostgreSQL is not actually
 * healthy for this application's purposes. Used as the container health
 * probe per the deployment architecture doc.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')]);
  }
}
