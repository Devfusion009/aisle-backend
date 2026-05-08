import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../../database/entities/tenant.entity';
import { Document } from '../../database/entities/document.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { getPlanLimits } from '../../common/constants/plan-limits';

/**
 * QuotaService
 * Centralised pre-action enforcement for plan limits whose usage is computed
 * from aggregated state (storage bytes, monthly tokens). Counter-style limits
 * (users, assistants, datasets) stay inline in their respective services
 * because they share a single COUNT(*) query with the create path.
 */
@Injectable()
export class QuotasService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(UsageLog)
    private readonly usageLogRepo: Repository<UsageLog>,
  ) {}

  /**
   * Throws ForbiddenException if uploading `additionalBytes` would push the
   * tenant past its storage cap. `replacingBytes` is subtracted first to
   * support the document-replacement path (existing file is overwritten, so
   * the old size is reclaimed).
   */
  async assertStorageQuota(
    tenantId: string,
    additionalBytes: number,
    replacingBytes = 0,
  ): Promise<void> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const limits = getPlanLimits(tenant.plan);
    const currentBytes = await this.getCurrentStorageBytes(tenantId);
    const projected = currentBytes - replacingBytes + additionalBytes;

    if (projected > limits.maxStorageBytes) {
      throw new ForbiddenException(
        `Storage limit reached. Your plan (${tenant.plan}) allows ${formatBytes(limits.maxStorageBytes)}; ` +
        `this upload would bring usage to ${formatBytes(projected)}. ` +
        `Please ask your organization owner to upgrade.`,
      );
    }
  }

  /**
   * Throws ForbiddenException when the tenant has already consumed its
   * monthly token allowance. We can't predict how many tokens a single
   * request will spend, so this is a coarse "already-over" gate — anything
   * past the limit is blocked at the start of the next request.
   */
  async assertMonthlyTokenQuota(tenantId: string): Promise<void> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const limits = getPlanLimits(tenant.plan);
    const used = await this.getMonthlyTokensUsed(tenantId);

    if (used >= limits.monthlyTokenLimit) {
      throw new ForbiddenException(
        `Monthly token limit reached (${formatTokens(limits.monthlyTokenLimit)} tokens used on the ${tenant.plan} plan). ` +
        `Service will resume next billing cycle. ` +
        `Please ask your organization owner to upgrade for an immediate increase.`,
      );
    }
  }

  async getCurrentStorageBytes(tenantId: string): Promise<number> {
    const row = await this.documentRepo
      .createQueryBuilder('d')
      .select('COALESCE(SUM(d.fileSize), 0)', 'total')
      .where('d.tenantId = :tenantId', { tenantId })
      .getRawOne<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }

  async getMonthlyTokensUsed(tenantId: string): Promise<number> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const row = await this.usageLogRepo
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.tokensTotal), 0)', 'total')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.createdAt >= :monthStart', { monthStart })
      .getRawOne<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / (1024 ** 2);
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
