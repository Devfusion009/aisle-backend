import { Controller, Get, Post, Body, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service';
import { CreateAccessRequestDto, ApproveAccessRequestDto } from './dto/access-request.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Controller()
export class AccessRequestsController {
  constructor(private readonly accessRequestsService: AccessRequestsService) { }

  // ─── Public Endpoints ─────────────────────────────────────────────

  /**
   * Submit an access request (no auth required)
   * POST /auth/request-access
   */
  @Public()
  @Post('auth/request-access')
  async requestAccess(@Body() dto: CreateAccessRequestDto) {
    return this.accessRequestsService.create(dto);
  }

  /**
   * Get public tenant list for the request form
   * GET /auth/tenants
   */
  @Public()
  @Get('auth/tenants')
  async getPublicTenants() {
    return this.accessRequestsService.getPublicTenants();
  }

  // ─── Admin Endpoints ──────────────────────────────────────────────

  /**
   * List pending requests for admin's tenant
   * GET /admin/access-requests
   */
  @Get('admin/access-requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async getAdminRequests(@Tenant() tenant: TenantContext) {
    return this.accessRequestsService.findPendingForTenant(tenant.tenantId);
  }

  /**
   * Approve an access request (admin — creates USER in their tenant)
   * POST /admin/access-requests/:id/approve
   */
  @Post('admin/access-requests/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async adminApprove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveAccessRequestDto,
  ) {
    return this.accessRequestsService.approve(id, tenant.userId, tenant.role, tenant.tenantId, dto);
  }

  /**
   * Reject an access request (admin)
   * POST /admin/access-requests/:id/reject
   */
  @Post('admin/access-requests/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
  async adminReject(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accessRequestsService.reject(id, tenant.userId, tenant.role, tenant.tenantId);
  }

  // ─── Super Admin Endpoints ────────────────────────────────────────

  /**
   * List all pending requests (super admin)
   * GET /super-admin/access-requests
   */
  @Get('super-admin/access-requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.PLATFORM_ADMIN)
  async getSuperAdminRequests() {
    return this.accessRequestsService.findAllPending();
  }

  /**
   * Approve an access request (super admin)
   * POST /super-admin/access-requests/:id/approve
   */
  @Post('super-admin/access-requests/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.PLATFORM_ADMIN)
  async superAdminApprove(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveAccessRequestDto,
  ) {
    return this.accessRequestsService.approve(id, tenant.userId, tenant.role, tenant.tenantId, dto);
  }

  /**
   * Reject an access request (super admin)
   * POST /super-admin/access-requests/:id/reject
   */
  @Post('super-admin/access-requests/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.PLATFORM_ADMIN)
  async superAdminReject(
    @Tenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accessRequestsService.reject(id, tenant.userId, tenant.role, tenant.tenantId);
  }
}
