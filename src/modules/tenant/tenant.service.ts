import { Injectable, Logger, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual } from 'typeorm';
import { Tenant, TenantSettings } from '../../database/entities/tenant.entity';
import { User } from '../../database/entities/user.entity';
import { Assistant } from '../../database/entities/assistant.entity';
import { Document } from '../../database/entities/document.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { StorageService } from '../knowledge/storage.service';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { PLAN_LIMITS, getPlanLimits } from '../../common/constants/plan-limits';
import { PlansService } from '../plans/plans.service';

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5MB

@Injectable()
export class TenantService {
    private readonly logger = new Logger(TenantService.name);

    constructor(
        @InjectRepository(Tenant)
        private readonly tenantRepo: Repository<Tenant>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
        @InjectRepository(Assistant)
        private readonly assistantRepo: Repository<Assistant>,
        @InjectRepository(Document)
        private readonly documentRepo: Repository<Document>,
        @InjectRepository(UsageLog)
        private readonly usageLogRepo: Repository<UsageLog>,
        private readonly storageService: StorageService,
        private readonly plansService: PlansService,
    ) { }

    /**
     * Get tenant info for the current user's tenant
     */
    async getTenantInfo(tenantId: string) {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) {
            throw new NotFoundException('Tenant not found');
        }
        return {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            logoUrl: tenant.settings?.branding?.logoUrl || null,
            createdAt: tenant.createdAt,
        };
    }

    /**
     * Get billing info: current plan, limits, usage, and plan comparison
     */
    async getBillingInfo(tenantId: string) {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) {
            throw new NotFoundException('Tenant not found');
        }

        const limits = getPlanLimits(tenant.plan);

        // Start of current month (UTC)
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

        const [currentUsers, currentAssistants, currentDatasets, storageResult, tokenResult] = await Promise.all([
            this.userRepo.count({ where: { tenantId, role: In([UserRole.TENANT_ADMIN, UserRole.EDITOR, UserRole.USER]) } }),
            this.assistantRepo.count({ where: { tenantId, isDataset: false } }),
            this.assistantRepo.count({ where: { tenantId, isDataset: true } }),
            this.documentRepo
                .createQueryBuilder('d')
                .select('COALESCE(SUM(d.fileSize), 0)', 'total')
                .where('d.tenantId = :tenantId', { tenantId })
                .getRawOne(),
            this.usageLogRepo
                .createQueryBuilder('u')
                .select('COALESCE(SUM(u.tokensTotal), 0)', 'total')
                .where('u.tenantId = :tenantId', { tenantId })
                .andWhere('u.createdAt >= :monthStart', { monthStart })
                .getRawOne(),
        ]);

        const formatStorageGB = (bytes: number) => {
            const gb = bytes / (1024 * 1024 * 1024);
            return gb >= 1 ? `${Math.round(gb)} GB` : `${(gb * 1024).toFixed(0)} MB`;
        };

        const formatTokens = (num: number) => {
            if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(0)}M`;
            if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`;
            return String(num);
        };

        // Pull display metadata (price/displayName) from the DB so the billing
        // page reflects whatever the platform admin set in /super-admin/plans.
        // Falls back to in-memory PLAN_LIMITS if the DB read fails so the page
        // still renders with limit data on a transient outage.
        let planComparison: any[];
        try {
            const dbPlans = await this.plansService.getActivePlans();
            planComparison = dbPlans.map((p) => ({
                plan: p.code,
                displayName: p.displayName ?? p.name,
                price: Number(p.price),
                currency: p.currency,
                billingPeriod: p.billingPeriod,
                maxUsers: p.maxUsers,
                maxAssistants: p.maxAssistants,
                maxDatasets: p.maxDatasets,
                maxStorageDisplay: formatStorageGB(Number(p.maxStorageBytes)),
                maxStorageBytes: Number(p.maxStorageBytes),
                monthlyTokensDisplay: formatTokens(Number(p.monthlyTokenLimit)),
                monthlyTokenLimit: Number(p.monthlyTokenLimit),
            }));
        } catch (err) {
            this.logger.warn('Falling back to in-memory PLAN_LIMITS for billing comparison', err as any);
            planComparison = Object.keys(PLAN_LIMITS).map((p) => {
                const l = PLAN_LIMITS[p];
                return {
                    plan: p,
                    displayName: p.charAt(0).toUpperCase() + p.slice(1),
                    price: 0,
                    currency: 'USD',
                    billingPeriod: 'monthly',
                    maxUsers: l.maxUsers,
                    maxAssistants: l.maxAssistants,
                    maxDatasets: l.maxDatasets,
                    maxStorageDisplay: formatStorageGB(l.maxStorageBytes),
                    maxStorageBytes: l.maxStorageBytes,
                    monthlyTokensDisplay: formatTokens(l.monthlyTokenLimit),
                    monthlyTokenLimit: l.monthlyTokenLimit,
                };
            });
        }

        return {
            plan: tenant.plan,
            limits,
            usage: {
                currentUsers,
                currentAssistants,
                currentDatasets,
                currentStorageBytes: Number(storageResult?.total ?? 0),
                monthlyTokensUsed: Number(tokenResult?.total ?? 0),
            },
            planComparison,
        };
    }

    /**
     * Upload organization logo (admin only)
     */
    async uploadLogo(tenant: TenantContext, file: Express.Multer.File) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
            throw new BadRequestException('Invalid image type. Allowed: PNG, JPEG, WebP, SVG');
        }
        if (file.size > MAX_LOGO_SIZE) {
            throw new BadRequestException('Logo too large. Maximum size: 5MB');
        }

        const tenantEntity = await this.tenantRepo.findOne({ where: { id: tenant.tenantId } });
        if (!tenantEntity) {
            throw new NotFoundException('Tenant not found');
        }

        // Delete old logo if exists
        const oldLogoKey = tenantEntity.settings?.branding?.logoUrl;
        if (oldLogoKey) {
            try {
                await this.storageService.deleteFile(oldLogoKey);
            } catch (err) {
                this.logger.warn(`Failed to delete old logo: ${oldLogoKey}`);
            }
        }

        // Upload new logo
        const s3Key = `logos/${tenant.tenantId}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

        try {
            await this.storageService.uploadFile(s3Key, file.buffer, file.mimetype);
        } catch (error) {
            this.logger.error(`Failed to upload logo to S3: ${s3Key}`, error);
            throw new InternalServerErrorException('Failed to upload logo to storage');
        }

        // Update tenant settings; if DB fails, clean up the uploaded file
        try {
            const settings: TenantSettings = tenantEntity.settings || {};
            settings.branding = { ...settings.branding, logoUrl: s3Key };
            tenantEntity.settings = settings;
            await this.tenantRepo.save(tenantEntity);
        } catch (error) {
            this.logger.error(`Failed to save logo reference for tenant ${tenant.tenantId}, cleaning up S3`, error);
            try {
                await this.storageService.deleteFile(s3Key);
            } catch (cleanupError) {
                this.logger.error(`Failed to clean up orphaned logo file: ${s3Key}`, cleanupError);
            }
            throw new InternalServerErrorException('Failed to save logo settings');
        }

        this.logger.log(`Logo uploaded for tenant ${tenant.tenantId}: ${s3Key}`);
        return { logoUrl: s3Key, message: 'Logo uploaded successfully' };
    }

    /**
     * Get logo bytes for a tenant (served via Redis cache).
     *
     * Performance: previous implementation opened a fresh S3 stream per request; under
     * high concurrency the Node.js event loop became the bottleneck. This version
     * serves from Redis on cache hit (~5 ms) and populates on miss.
     */
    async getLogo(
        caller: TenantContext,
        tenantId: string,
    ): Promise<{ buf: Buffer; mimeType: string; etag: string } | null> {
        // Tenant-scoped: callers may only fetch their own tenant's logo.
        // Platform admins may fetch any tenant's logo (cross-tenant admin views).
        if (caller.role !== UserRole.PLATFORM_ADMIN && caller.tenantId !== tenantId) {
            return null;
        }

        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant || !tenant.settings?.branding?.logoUrl) {
            return null;
        }

        const s3Key = tenant.settings.branding.logoUrl;
        const mimeHint = this.inferImageMime(s3Key);

        try {
            const { buf, mime, etag } = await this.storageService.downloadFileCached(s3Key, mimeHint);
            return { buf, mimeType: mime, etag };
        } catch (error) {
            this.logger.error(`Failed to get logo for tenant ${tenantId}: ${s3Key}`, error);
            return null;
        }
    }

    private inferImageMime(s3Key: string): string {
        const ext = s3Key.split('.').pop()?.toLowerCase() || '';
        const mimeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            svg: 'image/svg+xml',
        };
        return mimeMap[ext] || 'image/png';
    }

    /**
     * Upload profile photo for the current user
     */
    async uploadProfilePhoto(tenant: TenantContext, file: Express.Multer.File) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
            throw new BadRequestException('Invalid image type. Allowed: PNG, JPEG, WebP, SVG');
        }
        if (file.size > MAX_LOGO_SIZE) {
            throw new BadRequestException('Photo too large. Maximum size: 5MB');
        }

        const user = await this.userRepo.findOne({ where: { id: tenant.userId, tenantId: tenant.tenantId } });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Delete old photo if exists
        if (user.profilePhotoUrl) {
            try {
                await this.storageService.deleteFile(user.profilePhotoUrl);
            } catch (err) {
                this.logger.warn(`Failed to delete old profile photo: ${user.profilePhotoUrl}`);
            }
        }

        // Upload new photo
        const s3Key = `profile-photos/${tenant.tenantId}/${tenant.userId}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

        try {
            await this.storageService.uploadFile(s3Key, file.buffer, file.mimetype);
        } catch (error) {
            this.logger.error(`Failed to upload profile photo to S3: ${s3Key}`, error);
            throw new InternalServerErrorException('Failed to upload profile photo');
        }

        // Update user record
        try {
            user.profilePhotoUrl = s3Key;
            await this.userRepo.save(user);
        } catch (error) {
            this.logger.error(`Failed to save profile photo reference for user ${tenant.userId}, cleaning up S3`, error);
            try {
                await this.storageService.deleteFile(s3Key);
            } catch (cleanupError) {
                this.logger.error(`Failed to clean up orphaned profile photo: ${s3Key}`, cleanupError);
            }
            throw new InternalServerErrorException('Failed to save profile photo');
        }

        this.logger.log(`Profile photo uploaded for user ${tenant.userId}: ${s3Key}`);
        return { profilePhotoUrl: s3Key, message: 'Profile photo uploaded successfully' };
    }

    /**
     * Delete profile photo for the current user
     */
    async deleteProfilePhoto(tenant: TenantContext) {
        const user = await this.userRepo.findOne({ where: { id: tenant.userId, tenantId: tenant.tenantId } });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        if (!user.profilePhotoUrl) {
            return; // No photo to delete
        }

        // Delete from S3
        try {
            await this.storageService.deleteFile(user.profilePhotoUrl);
        } catch (err) {
            this.logger.warn(`Failed to delete profile photo from S3: ${user.profilePhotoUrl}`);
        }

        // Clear in DB
        user.profilePhotoUrl = null as any;
        await this.userRepo.save(user);

        this.logger.log(`Profile photo deleted for user ${tenant.userId}`);
    }

    /**
     * Get profile photo bytes for a user (served via Redis cache).
     */
    async getProfilePhoto(
        userId: string,
        tenantId: string,
    ): Promise<{ buf: Buffer; mimeType: string; etag: string } | null> {
        const user = await this.userRepo.findOne({ where: { id: userId, tenantId } });
        if (!user || !user.profilePhotoUrl) {
            return null;
        }

        const s3Key = user.profilePhotoUrl;
        const mimeHint = this.inferImageMime(s3Key);

        try {
            const { buf, mime, etag } = await this.storageService.downloadFileCached(s3Key, mimeHint);
            return { buf, mimeType: mime, etag };
        } catch (error) {
            this.logger.error(`Failed to get profile photo for user ${userId}: ${s3Key}`, error);
            return null;
        }
    }

    /**
     * Get profile photo bytes by user ID, enforcing access control.
     *
     * Members may only fetch profile photos of users in their own tenant;
     * platform admins may fetch any. Returns null on access denial so the
     * controller responds with 404 and does not leak user existence
     * across tenant boundaries.
     */
    async getProfilePhotoByUserId(
        caller: TenantContext,
        userId: string,
    ): Promise<{ buf: Buffer; mimeType: string; etag: string } | null> {
        const user = await this.userRepo.findOne({ where: { id: userId } });
        if (!user || !user.profilePhotoUrl) {
            return null;
        }
        if (caller.role !== UserRole.PLATFORM_ADMIN && caller.tenantId !== user.tenantId) {
            return null;
        }
        return this.getProfilePhoto(userId, user.tenantId);
    }

    /**
     * Upgrade or change the tenant's subscription plan.
     * Updates tenant.plan in the database; all limit checks (users, assistants, etc.)
     * derive from this field at runtime, so they take effect immediately.
     *
     * Only tenant owners can call this — enforced by the @Roles decorator on
     * the controller route.
     */
    async upgradePlan(tenantId: string, newPlan: string): Promise<{ plan: string; limits: ReturnType<typeof getPlanLimits> }> {
        const validPlans = Object.keys(PLAN_LIMITS);
        if (!validPlans.includes(newPlan)) {
            throw new BadRequestException(`Invalid plan. Allowed values: ${validPlans.join(', ')}`);
        }

        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) throw new NotFoundException('Tenant not found');

        if (tenant.plan === newPlan) {
            throw new BadRequestException('Tenant is already on this plan');
        }

        const previousPlan = tenant.plan;
        tenant.plan = newPlan;
        await this.tenantRepo.save(tenant);

        this.logger.log(`Tenant ${tenantId} plan changed: ${previousPlan} → ${newPlan}`);

        return {
            plan: newPlan,
            limits: getPlanLimits(newPlan),
        };
    }

    // ── Integrations ──────────────────────────────────────────────────────

    async getIntegrations(tenantId: string) {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) throw new NotFoundException('Tenant not found');
        const slackUrl = tenant.settings?.integrations?.slack?.webhookUrl ?? null;
        return {
            slack: { connected: !!slackUrl, webhookUrl: slackUrl },
        };
    }

    async saveSlackWebhook(tenantId: string, webhookUrl: string | null): Promise<void> {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) throw new NotFoundException('Tenant not found');

        const settings: TenantSettings = tenant.settings ?? {};
        if (webhookUrl) {
            settings.integrations = { ...settings.integrations, slack: { webhookUrl } };
        } else {
            if (settings.integrations) {
                delete settings.integrations.slack;
            }
        }
        await this.tenantRepo.update(tenantId, { settings });
    }

    async testSlackWebhook(tenantId: string): Promise<{ ok: boolean; error?: string }> {
        const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
        if (!tenant) throw new NotFoundException('Tenant not found');

        const webhookUrl = tenant.settings?.integrations?.slack?.webhookUrl;
        if (!webhookUrl) {
            throw new BadRequestException('No Slack webhook URL configured');
        }

        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `✅ *${tenant.name}* — Aisle integration is working correctly!`,
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                return { ok: false, error: `Slack returned ${res.status}: ${body}` };
            }
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: err?.message ?? 'Network error' };
        }
    }
}
