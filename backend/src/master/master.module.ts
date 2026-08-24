import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MasterUsersController } from './master-users.controller';
import { MasterUsersService } from './master-users.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [MasterUsersController],
  providers: [MasterUsersService],
})
export class MasterModule {}
