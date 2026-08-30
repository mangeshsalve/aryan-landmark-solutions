import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LoginDto } from './dto/login.dto';
import { ApplicationAuthService } from './services/application-auth.service';

/**
 * POST /api/v1/auth/login — per docs/api/openapi.yaml.
 * username is users.user_id. CUSTOMER and MASTER cannot use this endpoint
 * (see ApplicationAuthService for why that's structurally guaranteed,
 * not just an application-level check).
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly applicationAuthService: ApplicationAuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Stricter than the global default — login endpoints are the primary
  // brute-force target. 5 attempts per 15 minutes per IP.
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async login(@Body() dto: LoginDto) {
    const result = await this.applicationAuthService.login(dto.email, dto.password);
    return { success: true, data: result };
  }
}
