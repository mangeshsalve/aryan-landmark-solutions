import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { MasterAuthController } from './master-auth.controller';
import { JwtApplicationAuthGuard } from './guards/jwt-application-auth.guard';
import { JwtMasterAuthGuard } from './guards/jwt-master-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ApplicationAuthService } from './services/application-auth.service';
import { MasterAuthService } from './services/master-auth.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

@Module({
  // JwtModule is registered without a global secret/expiry: TokenService
  // supplies a distinct secret and expiry per call (signApplicationToken
  // vs signMasterToken), which JwtModule.register's static config can't
  // express for two independently-secreted token types in one module.
  imports: [JwtModule.register({})],
  controllers: [AuthController, MasterAuthController],
  providers: [
    PasswordService,
    TokenService,
    ApplicationAuthService,
    MasterAuthService,
    JwtApplicationAuthGuard,
    JwtMasterAuthGuard,
    RolesGuard,
  ],
  exports: [TokenService, JwtApplicationAuthGuard, JwtMasterAuthGuard, RolesGuard],
})
export class AuthModule {}
