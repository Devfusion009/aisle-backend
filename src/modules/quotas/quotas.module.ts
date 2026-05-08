import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuotasService } from './quotas.service';
import { Tenant } from '../../database/entities/tenant.entity';
import { Document } from '../../database/entities/document.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant, Document, UsageLog])],
  providers: [QuotasService],
  exports: [QuotasService],
})
export class QuotasModule {}
