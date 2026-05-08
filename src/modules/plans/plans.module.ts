import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionPlan } from '../../database/entities/subscription-plan.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SubscriptionPlan, Tenant])],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
