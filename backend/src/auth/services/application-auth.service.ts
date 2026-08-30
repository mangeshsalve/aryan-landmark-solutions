import { Injectable } from '@nestjs/common';
import { InvalidCredentialsException } from '../../common/exceptions/app.exception';
import {
  ApplicationRoleValue,
  UserStatusValue,
  UserTypeValue,
} from '../../common/types/domain-enums';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { APPLICATION_TOKEN_EXPIRES_IN_SECONDS, TokenService } from './token.service';

export interface ApplicationLoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: {
    id: string;
    userId: string | null;
    userType: UserTypeValue;
    role: ApplicationRoleValue | null;
    name: string;
    email: string | null;
    mobile: string | null;
    status: UserStatusValue;
  };
}

/**
 * Login for APPLICATION_USER (ADMIN/EMPLOYEE) only. CUSTOMER rows always
 * have user_id = NULL (enforced by chk_users_identity in schema.sql), so
 * filtering on userType='APPLICATION_USER' AND userId=<username> already
 * structurally excludes CUSTOMER and MASTER — there is no username a
 * customer could supply that would match a row here.
 *
 * A single generic AUTH_INVALID_CREDENTIALS response is used for every
 * failure case (unknown user, wrong password, inactive, blocked) so the
 * API never reveals which part of the login attempt was wrong.
 */
@Injectable()
export class ApplicationAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

  async login(email: string, password: string): Promise<ApplicationLoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, userType: 'APPLICATION_USER' },
    });

    if (!user || !user.passwordHash || !user.role) {
      throw new InvalidCredentialsException();
    }

    if (user.status !== 'ACTIVE') {
      throw new InvalidCredentialsException();
    }

    const passwordMatches = await this.passwordService.verify(password, user.passwordHash);
    if (!passwordMatches) {
      throw new InvalidCredentialsException();
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.tokenService.signApplicationToken({
      sub: user.id,
      userId: user.userId!,
      role: user.role,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: APPLICATION_TOKEN_EXPIRES_IN_SECONDS,
      user: {
        id: user.id,
        userId: user.userId,
        userType: user.userType,
        role: user.role,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        status: user.status,
      },
    };
  }
}
