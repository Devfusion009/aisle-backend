import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, DeepPartial } from 'typeorm';
import {
  BaseRepository,
  DateRange,
  PLAYGROUND_PREFIX,
} from './base.repository';
import { UsageLog } from '../entities/usage-log.entity';

export interface TokenAggregation {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
}

export interface DailyTrendRow {
  date: string;
  conversations: number;
  tokens: number;
}

export interface HourlyRow {
  hour: string;
  avg: number;
}

export interface AssistantUsageRow {
  assistantId: string;
  conversations: number;
  tokens: number;
  avgLatencyMs: number;
}

@Injectable()
export class UsageLogRepo extends BaseRepository<UsageLog> {
  private readonly logger = new Logger(UsageLogRepo.name);

  constructor(
    @InjectRepository(UsageLog) repo: Repository<UsageLog>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /**
   * Log a usage event (fire-and-forget — never throws to caller).
   */
  logAsync(data: DeepPartial<UsageLog>): void {
    const entity = this.repo.create(data);
    this.repo.save(entity).catch((err) => {
      this.logger.error('Failed to log usage', err);
    });
  }

  /** Log and await */
  async log(data: DeepPartial<UsageLog>): Promise<UsageLog> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  // ── Aggregation queries ────────────────────────────────────────────

  /** Sum tokens within a date range */
  async sumTokens(
    tenantId: string,
    range?: DateRange,
  ): Promise<TokenAggregation> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.tokensInput), 0)', 'totalInput')
      .addSelect('COALESCE(SUM(u.tokensOutput), 0)', 'totalOutput')
      .addSelect('COALESCE(SUM(u.tokensTotal), 0)', 'totalTokens')
      .where('u.tenantId = :tenantId', { tenantId });

    if (range) this.applyDateRange(qb, 'u', range);

    const row = await qb.getRawOne();
    return {
      totalInput: parseInt(row.totalInput, 10),
      totalOutput: parseInt(row.totalOutput, 10),
      totalTokens: parseInt(row.totalTokens, 10),
    };
  }

  /** Count distinct conversations within a date range (excludes playground) */
  async countConversations(
    tenantId: string,
    range?: DateRange,
  ): Promise<number> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('COUNT(DISTINCT u.conversationId)', 'count')
      .leftJoin('conversations', 'c', 'c.id = u.conversationId')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      );

    if (range) this.applyDateRange(qb, 'u', range);

    const row = await qb.getRawOne();
    return parseInt(row?.count ?? '0', 10);
  }

  /** Average latency within a date range */
  async avgLatency(
    tenantId: string,
    range?: DateRange,
  ): Promise<number> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('AVG(u.latencyMs)', 'avg')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.success = true')
      .andWhere('u.latencyMs IS NOT NULL');

    if (range) this.applyDateRange(qb, 'u', range);

    const row = await qb.getRawOne();
    return parseFloat(row?.avg ?? '0');
  }

  /** Average response time grouped by hour (0–23) */
  async responseTimeByHour(
    tenantId: string,
    range?: DateRange,
  ): Promise<HourlyRow[]> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('EXTRACT(HOUR FROM u.createdAt)', 'hour')
      .addSelect('AVG(u.latencyMs)', 'avg')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.success = true')
      .andWhere('u.latencyMs IS NOT NULL')
      .groupBy('EXTRACT(HOUR FROM u.createdAt)')
      .orderBy('EXTRACT(HOUR FROM u.createdAt)', 'ASC');

    if (range) this.applyDateRange(qb, 'u', range);

    return qb.getRawMany();
  }

  /**
   * Daily trend: conversations + tokens grouped by date.
   * Excludes playground sessions.
   */
  async dailyTrend(
    tenantId: string,
    range: DateRange,
  ): Promise<DailyTrendRow[]> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('DATE(u.createdAt)', 'date')
      .addSelect('COUNT(DISTINCT u.conversationId)', 'conversations')
      .addSelect('COALESCE(SUM(u.tokensTotal), 0)', 'tokens')
      .leftJoin('conversations', 'c', 'c.id = u.conversationId')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      )
      .groupBy('DATE(u.createdAt)')
      .orderBy('DATE(u.createdAt)', 'ASC');

    this.applyDateRange(qb, 'u', range);

    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      date: r.date,
      conversations: parseInt(r.conversations, 10),
      tokens: parseInt(r.tokens, 10),
    }));
  }

  /** Usage grouped by assistant */
  async usageByAssistant(
    tenantId: string,
    range?: DateRange,
  ): Promise<AssistantUsageRow[]> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('u.assistantId', 'assistantId')
      .addSelect('COUNT(DISTINCT u.conversationId)', 'conversations')
      .addSelect('COALESCE(SUM(u.tokensTotal), 0)', 'tokens')
      .addSelect('AVG(u.latencyMs)', 'avgLatencyMs')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.assistantId IS NOT NULL')
      .groupBy('u.assistantId');

    if (range) this.applyDateRange(qb, 'u', range);

    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      assistantId: r.assistantId,
      conversations: parseInt(r.conversations, 10),
      tokens: parseInt(r.tokens, 10),
      avgLatencyMs: parseFloat(r.avgLatencyMs ?? '0'),
    }));
  }

  /** Sum tokens for a specific user */
  async sumTokensByUser(
    tenantId: string,
    userId: string,
    range?: DateRange,
  ): Promise<number> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.tokensTotal), 0)', 'total')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.userId = :userId', { userId });

    if (range) this.applyDateRange(qb, 'u', range);

    const row = await qb.getRawOne();
    return parseInt(row?.total ?? '0', 10);
  }

  /** Get recent usage logs (for admin audit / debugging) */
  async getRecent(
    tenantId: string,
    limit = 50,
  ): Promise<UsageLog[]> {
    return this.repo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(1, limit), 200),
    });
  }
}
