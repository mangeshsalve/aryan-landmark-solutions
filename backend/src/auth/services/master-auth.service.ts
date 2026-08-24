import { Injectable } from '@nestjs/common';
import { InvalidCredentialsException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { MASTER_TOKEN_EXPIRES_IN_SECONDS, TokenService } from './token.service';

export interface MasterLoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  tokenScope: 'MASTER';
  expiresIn: number;
}

/**
 * Login for user_type = MASTER only. MASTER rows are manually provisioned
 * directly in the users table (no registration endpoint exists anywhere
 * in this API — see docs/api/openapi.yaml's description of
 * /master-auth/login). Same generic-failure principle as
 * ApplicationAuthService: one response shape for unknown user, wrong
 * password, or inactive/blocked status.
 */
@Injectable()
export class MasterAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

  async login(username: string, password: string): Promise<MasterLoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { userId: username, userType: 'MASTER' },
    });

    if (!user || !user.passwordHash) {
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

    const accessToken = await this.tokenService.signMasterToken({
      sub: user.id,
      userId: user.userId!,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      tokenScope: 'MASTER',
      expiresIn: MASTER_TOKEN_EXPIRES_IN_SECONDS,
    };
  }
}
