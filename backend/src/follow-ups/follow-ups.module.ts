import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsService } from './follow-ups.service';
import { TodayFollowUpsController } from './today-follow-ups.controller';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [FollowUpsController, TodayFollowUpsController],
  providers: [FollowUpsService],
})
export class FollowUpsModule {}
