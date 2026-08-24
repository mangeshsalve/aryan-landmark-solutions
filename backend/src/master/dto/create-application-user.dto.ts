import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const APPLICATION_ROLES = ['ADMIN', 'EMPLOYEE'] as const;

/**
 * Matches components.schemas.CreateApplicationUserRequest in
 * docs/api/openapi.yaml exactly. `role` is restricted to ADMIN/EMPLOYEE
 * at the type/validation level — CUSTOMER and MASTER are not
 * representable values for this field, so a request naming either is
 * rejected by the global ValidationPipe before ever reaching the
 * service. No createdBy/updatedBy fields — those are derived from the
 * authenticated MASTER JWT in MasterUsersService, never accepted from
 * the client.
 */
export class CreateApplicationUserDto {
  @ApiPropertyOptional({
    example: 'EMP001',
    description: 'Optional — generated server-side if omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  userId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20)
  mobile!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  alternateMobile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  pincode?: string;

  @ApiProperty({ format: 'password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ enum: APPLICATION_ROLES })
  @IsIn(APPLICATION_ROLES)
  role!: (typeof APPLICATION_ROLES)[number];
}
