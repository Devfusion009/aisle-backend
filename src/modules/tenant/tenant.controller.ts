import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
    Res,
    UseInterceptors,
    UploadedFile,
    ParseUUIDPipe,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { TenantService } from './tenant.service';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';

@Controller('tenant')
export class TenantController {
    constructor(private readonly tenantService: TenantService) { }

    /**
     * Get current tenant info
     * GET /tenant/info
     */
    @Get('info')
    async getTenantInfo(@Tenant() tenant: TenantContext) {
        return this.tenantService.getTenantInfo(tenant.tenantId);
    }

    /**
     * Get billing info (plan, limits, usage)
     * GET /tenant/billing
     */
    @Get('billing')
    @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
    async getBilling(@Tenant() tenant: TenantContext) {
        return this.tenantService.getBillingInfo(tenant.tenantId);
    }

    /**
     * Upgrade / change the tenant's plan (owner only)
     * PATCH /tenant/plan
     * Body: { plan: 'starter' | 'business' | 'enterprise' }
     */
    @Patch('plan')
    @Roles(UserRole.TENANT_OWNER)
    async upgradePlan(
        @Tenant() tenant: TenantContext,
        @Body() body: { plan: string },
    ) {
        return this.tenantService.upgradePlan(tenant.tenantId, body.plan);
    }

    /**
     * Upload organization logo (admin only)
     * POST /tenant/logo
     */
    @Post('logo')
    @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN, UserRole.PLATFORM_ADMIN)
    @UseInterceptors(FileInterceptor('logo'))
    async uploadLogo(
        @Tenant() tenant: TenantContext,
        @UploadedFile() file: Express.Multer.File,
    ) {
        return this.tenantService.uploadLogo(tenant, file);
    }

    /**
     * Serve tenant logo image (authenticated).
     * GET /tenant/logo/:tenantId
     *
     * Tenant-scoped: members can only fetch their own tenant's logo.
     * Platform admins can fetch any tenant's logo (super-admin views).
     */
    @Get('logo/:tenantId')
    async getLogo(
        @Tenant() caller: TenantContext,
        @Param('tenantId', ParseUUIDPipe) tenantId: string,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const result = await this.tenantService.getLogo(caller, tenantId);
        if (!result) {
            return res.status(HttpStatus.NOT_FOUND).json({ message: 'No logo found' });
        }

        // Browser-side conditional GET: return 304 if client already has the bytes
        if (req.headers['if-none-match'] === result.etag) {
            return res.status(HttpStatus.NOT_MODIFIED).end();
        }

        res.set({
            'Content-Type': result.mimeType,
            'Content-Length': String(result.buf.length),
            'ETag': result.etag,
            // Tenant-private asset — keep it out of shared caches.
            'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
        });
        res.end(result.buf);
    }

    /**
     * Upload current user's profile photo
     * POST /tenant/profile-photo
     */
    @Post('profile-photo')
    @UseInterceptors(FileInterceptor('photo'))
    async uploadProfilePhoto(
        @Tenant() tenant: TenantContext,
        @UploadedFile() file: Express.Multer.File,
    ) {
        return this.tenantService.uploadProfilePhoto(tenant, file);
    }

    /**
     * Delete current user's profile photo
     * DELETE /tenant/profile-photo
     */
    @Delete('profile-photo')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteProfilePhoto(@Tenant() tenant: TenantContext) {
        return this.tenantService.deleteProfilePhoto(tenant);
    }

    /**
     * Get integration status for this tenant
     * GET /tenant/integrations
     */
    @Get('integrations')
    @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
    async getIntegrations(@Tenant() tenant: TenantContext) {
        return this.tenantService.getIntegrations(tenant.tenantId);
    }

    /**
     * Save / clear Slack webhook URL
     * PATCH /tenant/integrations/slack  — body: { webhookUrl: string | null }
     */
    @Patch('integrations/slack')
    @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
    @HttpCode(HttpStatus.NO_CONTENT)
    async saveSlackWebhook(
        @Tenant() tenant: TenantContext,
        @Body() body: { webhookUrl: string | null },
    ) {
        await this.tenantService.saveSlackWebhook(tenant.tenantId, body.webhookUrl ?? null);
    }

    /**
     * Send a test message to the configured Slack webhook
     * POST /tenant/integrations/slack/test
     */
    @Post('integrations/slack/test')
    @Roles(UserRole.TENANT_OWNER, UserRole.TENANT_ADMIN)
    async testSlackWebhook(@Tenant() tenant: TenantContext) {
        return this.tenantService.testSlackWebhook(tenant.tenantId);
    }

    /**
     * Serve profile photo image (authenticated).
     * GET /tenant/profile-photo/:userId
     *
     * Tenant-scoped: members can fetch profile photos of users in the
     * same tenant. Platform admins can fetch any. Cross-tenant lookups
     * by an authenticated regular user are rejected with 404 to avoid
     * confirming the existence of users in other tenants.
     */
    @Get('profile-photo/:userId')
    async getProfilePhoto(
        @Tenant() caller: TenantContext,
        @Param('userId', ParseUUIDPipe) userId: string,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const result = await this.tenantService.getProfilePhotoByUserId(caller, userId);
        if (!result) {
            return res.status(HttpStatus.NOT_FOUND).json({ message: 'No profile photo found' });
        }

        if (req.headers['if-none-match'] === result.etag) {
            return res.status(HttpStatus.NOT_MODIFIED).end();
        }

        res.set({
            'Content-Type': result.mimeType,
            'Content-Length': String(result.buf.length),
            'ETag': result.etag,
            'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
        });
        res.end(result.buf);
    }
}
