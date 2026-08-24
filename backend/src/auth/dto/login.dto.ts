import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Matches components.schemas.LoginRequest in docs/api/openapi.yaml.
 * Deliberately has exactly these two fields — the global ValidationPipe's
 * forbidNonWhitelisted rejects any request that tries to also send role,
 * userType, id, or any other identity field.
 */
export class LoginDto {
  @ApiProperty({ example: 'EMP001', description: 'users.user_id' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  username!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
