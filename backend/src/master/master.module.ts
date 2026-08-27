import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MasterUsersController } from './master-users.controller';
import { MasterUsersService } from './master-users.service';

@Module({
  imports: [AuthModule, AuditModule, UsersModule],
  controllers: [MasterUsersController],
  providers: [MasterUsersService],
})
export class MasterModule {}
