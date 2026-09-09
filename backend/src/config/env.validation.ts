import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Variables actually consumed by the application, validated at startup so
 * the process fails fast on a missing/invalid value rather than starting
 * partially configured. Grows additively as each phase introduces new
 * required variables (Phase 1: app/db/logging; Phase 2 adds the two JWT
 * secrets below).
 */
class EnvironmentVariables {
  @IsIn(['development', 'test', 'staging', 'production'])
  NODE_ENV!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL?: string;

  @IsString()
  @MinLength(16, { message: 'JWT_ACCESS_SECRET must be at least 16 characters.' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(16, { message: 'MASTER_JWT_ACCESS_SECRET must be at least 16 characters.' })
  MASTER_JWT_ACCESS_SECRET!: string;

  // --- Cloudflare R2 (Phase 5) ---
  // All optional: the application must start with none of these set. See
  // src/storage/cloudflare-r2-storage.service.ts — R2-dependent
  // operations check isConfigured() and fail clearly at the point of use
  // instead of the process failing to start.
  @IsOptional()
  @IsString()
  CLOUDFLARE_R2_ACCOUNT_ID?: string;

  @IsOptional()
  @IsString()
  CLOUDFLARE_R2_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsString()
  CLOUDFLARE_R2_BUCKET?: string;

  @IsOptional()
  @IsString()
  CLOUDFLARE_R2_PUBLIC_BASE_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  ATTACHMENT_MAX_FILE_SIZE_BYTES?: number;
}

export function validateEnv(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Environment validation failed: ${message}`);
  }

  // Phase 1 production-readiness fix — the isolation between the two JWT
  // boundaries (see token.service.ts's doc comment: "a token from one
  // boundary is cryptographically incapable of passing the other's
  // guard") depends entirely on these two secrets actually being
  // different. class-validator's per-field decorators above can't express
  // a cross-field check, so it's a plain manual comparison here instead —
  // deliberately not logging either value, only naming the two variables.
  if (validatedConfig.JWT_ACCESS_SECRET === validatedConfig.MASTER_JWT_ACCESS_SECRET) {
    throw new Error(
      'Environment validation failed: JWT_ACCESS_SECRET and MASTER_JWT_ACCESS_SECRET must not be the same value.',
    );
  }

  return validatedConfig;
}
