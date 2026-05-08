import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { UsageLog } from '../../database/entities/usage-log.entity';

/**
 * Usage & Billing Module
 * Tracks token usage and provides usage analytics.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UsageLog])],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
