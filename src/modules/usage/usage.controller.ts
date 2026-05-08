import { Controller, Get, Param, Query, ParseUUIDPipe, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { UsageService, UsageSummary } from './usage.service';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';

/**
 * Usage Controller
 * REST API endpoints for usage analytics.
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly usageService: UsageService) { }

  /**
   * Get usage summary for the tenant
   * GET /usage/summary
   * Required role: ADMIN or MANAGER
   */
  @Get('summary')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getSummary(
    @Tenant() tenant: TenantContext,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<UsageSummary> {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.usageService.getSummary(tenant, start, end);
  }

  /**
   * Get recent API log rows for the tenant
   * GET /usage/logs?limit=50
   * Required role: ADMIN or MANAGER
   */
  @Get('logs')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getLogs(
    @Tenant() tenant: TenantContext,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.usageService.getRecentLogs(tenant, limit);
  }

  /**
   * Get usage for a specific assistant
   * GET /usage/assistants/:id
   * Required role: ADMIN or MANAGER
   */
  @Get('assistants/:id')
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getAssistantUsage(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.usageService.getAssistantUsage(tenant, id, start, end);
  }
}
