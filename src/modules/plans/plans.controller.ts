import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { PlansService } from './plans.service';
import { ConfigurePlansDto, CreatePlanDto, UpdatePlanDto } from './dto/plans.dto';
import { MinRole } from '../../common/decorators/rbac.decorators';
import { UserRole } from '../../common/interfaces/tenant-context.interface';

@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  /**
   * List active plans for any authenticated user. Used by the tenant billing
   * page to render pricing cards. The shape mirrors what the admin UI sends
   * back to the platform-admin endpoints.
   */
  @Get()
  async list() {
    const plans = await this.plansService.getActivePlans();
    return plans.map(toPublicPlan);
  }

  /**
   * Full list including deactivated plans — for the platform-admin UI.
   */
  @Get('all')
  @MinRole(UserRole.PLATFORM_ADMIN)
  async listAll() {
    const plans = await this.plansService.getAllPlans();
    return plans.map(toPublicPlan);
  }

  @Post()
  @MinRole(UserRole.PLATFORM_ADMIN)
  async create(@Body() dto: CreatePlanDto) {
    const plan = await this.plansService.createPlan(dto);
    return toPublicPlan(plan);
  }

  @Patch(':code')
  @MinRole(UserRole.PLATFORM_ADMIN)
  async update(@Param('code') code: string, @Body() dto: UpdatePlanDto) {
    const plan = await this.plansService.updatePlan(code, dto);
    return toPublicPlan(plan);
  }

  /**
   * One-shot configuration. The /super-admin/plans page sends every tier
   * the admin wants in a single payload; everything is upserted atomically
   * and the in-memory cache is refreshed in one go.
   */
  @Put('configure')
  @MinRole(UserRole.PLATFORM_ADMIN)
  async configure(@Body() dto: ConfigurePlansDto) {
    const plans = await this.plansService.configurePlans(dto.plans);
    return { count: plans.length, plans: plans.map(toPublicPlan) };
  }
}

function toPublicPlan(p: {
  id: string;
  name: string;
  displayName?: string | null;
  code: string;
  price: number;
  currency: string;
  billingPeriod: string;
  maxUsers: number;
  maxAssistants: number;
  maxDatasets: number;
  maxStorageBytes: number;
  monthlyTokenLimit: number;
  isActive: boolean;
}) {
  return {
    id: p.id,
    name: p.name,
    displayName: p.displayName ?? p.name,
    code: p.code,
    price: Number(p.price),
    currency: p.currency,
    billingPeriod: p.billingPeriod,
    maxUsers: p.maxUsers,
    maxAssistants: p.maxAssistants,
    maxDatasets: p.maxDatasets,
    maxStorageBytes: Number(p.maxStorageBytes),
    monthlyTokenLimit: Number(p.monthlyTokenLimit),
    isActive: p.isActive,
  };
}
