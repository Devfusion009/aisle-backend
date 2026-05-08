import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';

/**
 * Usage log input
 */
export interface UsageLogInput {
  tenantId: string;
  assistantId?: string | null;
  userId: string;
  conversationId?: string | null;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  provider: string;
  latencyMs?: number | null;
  success: boolean;
  errorMessage?: string | null;
}

/**
 * Usage summary response
 */
export interface UsageSummary {
  period: {
    start: Date;
    end: Date;
  };
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokens: number;
  averageLatencyMs: number;
  byModel: {
    model: string;
    requests: number;
    tokens: number;
  }[];
  byAssistant: {
    assistantId: string;
    requests: number;
    tokens: number;
  }[];
}

/**
 * Usage Service
 * Tracks and aggregates token usage for billing and analytics.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(UsageLog)
    private readonly usageLogRepository: Repository<UsageLog>,
  ) {}

  /**
   * Log a usage event
   * This is best-effort: failures are logged but never thrown to avoid
   * disrupting the critical chat/generation flow.
   */
  async logUsage(input: UsageLogInput): Promise<void> {
    try {
      const log = this.usageLogRepository.create({
        tenantId: input.tenantId,
        assistantId: input.assistantId ?? null,
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        tokensInput: input.tokensInput,
        tokensOutput: input.tokensOutput,
        tokensTotal: input.tokensInput + input.tokensOutput,
        model: input.model,
        provider: input.provider,
        latencyMs: input.latencyMs ?? null,
        success: input.success,
        errorMessage: input.errorMessage ?? null,
      });

      await this.usageLogRepository.save(log);
    } catch (error) {
      this.logger.error(
        `Failed to log usage event for tenant=${input.tenantId}, model=${input.model}`,
        error,
      );
      // Intentionally swallowed: usage logging should never break the chat flow
    }
  }

  /**
   * Get usage summary for a tenant
   */
  async getSummary(tenant: TenantContext, startDate?: Date, endDate?: Date): Promise<UsageSummary> {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default: 30 days
    const end = endDate || new Date();

    // Get all logs for the period
    const logs = await this.usageLogRepository.find({
      where: {
        tenantId: tenant.tenantId,
        createdAt: Between(start, end),
      },
    });

    // Aggregate by model
    const byModel = new Map<string, { requests: number; tokens: number }>();
    const byAssistant = new Map<string, { requests: number; tokens: number }>();

    let totalTokensInput = 0;
    let totalTokensOutput = 0;
    let totalLatency = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    for (const log of logs) {
      totalTokensInput += log.tokensInput;
      totalTokensOutput += log.tokensOutput;
      totalLatency += log.latencyMs || 0;

      if (log.success) {
        successfulRequests++;
      } else {
        failedRequests++;
      }

      // By model
      const modelStats = byModel.get(log.model) || { requests: 0, tokens: 0 };
      modelStats.requests++;
      modelStats.tokens += log.tokensTotal;
      byModel.set(log.model, modelStats);

      // By assistant
      const assistantId = log.assistantId || 'unknown';
      const assistantStats = byAssistant.get(assistantId) || { requests: 0, tokens: 0 };
      assistantStats.requests++;
      assistantStats.tokens += log.tokensTotal;
      byAssistant.set(assistantId, assistantStats);
    }

    return {
      period: { start, end },
      totalRequests: logs.length,
      successfulRequests,
      failedRequests,
      totalTokensInput,
      totalTokensOutput,
      totalTokens: totalTokensInput + totalTokensOutput,
      averageLatencyMs: logs.length > 0 ? Math.round(totalLatency / logs.length) : 0,
      byModel: Array.from(byModel.entries()).map(([model, stats]) => ({
        model,
        ...stats,
      })),
      byAssistant: Array.from(byAssistant.entries()).map(([assistantId, stats]) => ({
        assistantId,
        ...stats,
      })),
    };
  }

  /**
   * Get recent usage log rows for a tenant (for the API Logs view)
   */
  async getRecentLogs(
    tenant: TenantContext,
    limit = 50,
  ): Promise<{ id: string; model: string; latencyMs: number | null; success: boolean; errorMessage: string | null; createdAt: Date }[]> {
    const rows = await this.usageLogRepository.find({
      where: { tenantId: tenant.tenantId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(1, limit), 200),
      select: ['id', 'model', 'latencyMs', 'success', 'errorMessage', 'createdAt'],
    });
    return rows.map((r) => ({
      id: r.id,
      model: r.model,
      latencyMs: r.latencyMs ?? null,
      success: r.success,
      errorMessage: r.errorMessage ?? null,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get usage for a specific assistant
   */
  async getAssistantUsage(
    tenant: TenantContext,
    assistantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{ totalRequests: number; totalTokens: number; logs: UsageLog[] }> {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

    const logs = await this.usageLogRepository.find({
      where: {
        tenantId: tenant.tenantId,
        assistantId,
        createdAt: Between(start, end),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    const totalTokens = logs.reduce((sum, log) => sum + log.tokensTotal, 0);

    return {
      totalRequests: logs.length,
      totalTokens,
      logs,
    };
  }
}
