import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthTokenInvalidException } from '../../common/exceptions/app.exception';
import { ApplicationJwtPayload, MasterJwtPayload } from '../interfaces/jwt-payload.interface';

export const APPLICATION_TOKEN_EXPIRES_IN_SECONDS = 3600; // matches openapi.yaml expiresIn example
export const MASTER_TOKEN_EXPIRES_IN_SECONDS = 3600;

/**
 * Two independent signing boundaries, per the final authentication design:
 * application tokens (ADMIN/EMPLOYEE) and master tokens each use their own
 * secret, so a token issued for one can never be verified as the other —
 * a master-scoped credential is structurally incapable of being accepted
 * as an application token and vice versa, not just a matter of an
 * application-level role check.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signApplicationToken(payload: Omit<ApplicationJwtPayload, 'tokenType'>): Promise<string> {
    const secret = this.getSecret('JWT_ACCESS_SECRET');
    return this.jwtService.signAsync(
      { ...payload, tokenType: 'APPLICATION' } satisfies ApplicationJwtPayload,
      { secret, expiresIn: APPLICATION_TOKEN_EXPIRES_IN_SECONDS },
    );
  }

  async signMasterToken(payload: Omit<MasterJwtPayload, 'tokenType'>): Promise<string> {
    const secret = this.getSecret('MASTER_JWT_ACCESS_SECRET');
    return this.jwtService.signAsync(
      { ...payload, tokenType: 'MASTER' } satisfies MasterJwtPayload,
      { secret, expiresIn: MASTER_TOKEN_EXPIRES_IN_SECONDS },
    );
  }

  async verifyApplicationToken(token: string): Promise<ApplicationJwtPayload> {
    const secret = this.getSecret('JWT_ACCESS_SECRET');
    const payload = await this.verify<ApplicationJwtPayload>(token, secret);

    if (payload.tokenType !== 'APPLICATION') {
      throw new AuthTokenInvalidException();
    }

    return payload;
  }

  async verifyMasterToken(token: string): Promise<MasterJwtPayload> {
    const secret = this.getSecret('MASTER_JWT_ACCESS_SECRET');
    const payload = await this.verify<MasterJwtPayload>(token, secret);

    if (payload.tokenType !== 'MASTER') {
      throw new AuthTokenInvalidException();
    }

    return payload;
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwtService.verifyAsync<T>(token, { secret });
    } catch {
      // Never leak whether the failure was expiry, bad signature, or
      // malformed token — all collapse to the same generic response.
      throw new AuthTokenInvalidException();
    }
  }

  private getSecret(key: 'JWT_ACCESS_SECRET' | 'MASTER_JWT_ACCESS_SECRET'): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new Error(`Missing required configuration: ${key}`);
    }
    return value;
  }
}
