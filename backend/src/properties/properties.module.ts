import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PropertiesController } from './properties.controller';
import { PropertiesService } from './properties.service';
import { PublicPropertiesController } from './public-properties.controller';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [PropertiesController, PublicPropertiesController],
  providers: [PropertiesService],
})
export class PropertiesModule {}
