import { Controller, Get, Param, Query, ParseUUIDPipe, NotFoundException } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('metrics')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getMetrics(
    @Tenant() tenant: TenantContext,
    @Query('period') period?: string,
  ) {
    const days = [7, 30, 90].includes(Number(period)) ? Number(period) : 7;
    return this.dashboardService.getDashboardMetrics(tenant, days);
  }

  @Get('analytics')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getAnalytics(
    @Tenant() tenant: TenantContext,
    @Query('period') period?: string,
  ) {
    const days = [1, 7, 30, 90].includes(Number(period)) ? Number(period) : 30;
    return this.dashboardService.getAnalytics(tenant, days);
  }

  // Tenant-wide conversation read endpoints are restricted to OWNER/ADMIN.
  // EDITOR is intentionally excluded — editors manage assistants and
  // knowledge bases and have no business reading other users' private
  // chat histories (least-privilege).
  @Get('conversations')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getConversations(@Tenant() tenant: TenantContext) {
    return this.dashboardService.getAllConversations(tenant);
  }

  @Get('user-metrics')
  async getUserMetrics(@Tenant() tenant: TenantContext) {
    return this.dashboardService.getUserMetrics(tenant);
  }

  @Get('conversations/:id/messages')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getConversationMessages(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.dashboardService.getConversationMessages(tenant, id);
    if (!result) throw new NotFoundException('Conversation not found');
    return result;
  }
}
