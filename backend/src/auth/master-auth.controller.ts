import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LoginDto } from './dto/login.dto';
import { MasterAuthService } from './services/master-auth.service';

/**
 * POST /api/v1/master-auth/login — per docs/api/openapi.yaml.
 * MASTER is manually provisioned in the users table; there is no
 * master-registration endpoint anywhere in this API.
 */
@ApiTags('Master Authentication')
@Controller('master-auth')
export class MasterAuthController {
  constructor(private readonly masterAuthService: MasterAuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Stricter than the application login limit given the higher blast
  // radius of a master credential.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  async login(@Body() dto: LoginDto) {
    const result = await this.masterAuthService.login(dto.email, dto.password);
    return { success: true, data: result };
  }
}
