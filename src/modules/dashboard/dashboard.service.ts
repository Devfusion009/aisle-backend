import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Assistant } from '../../database/entities/assistant.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { Document } from '../../database/entities/document.entity';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { Message } from '../../database/entities/message.entity';
import { MessageVote } from '../../database/entities/message-vote.entity';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Assistant)
    private assistantRepository: Repository<Assistant>,
    @InjectRepository(Conversation)
    private conversationRepository: Repository<Conversation>,
    @InjectRepository(UsageLog)
    private usageLogRepository: Repository<UsageLog>,
    @InjectRepository(Document)
    private documentRepository: Repository<Document>,
    @InjectRepository(Message)
    private messageRepository: Repository<Message>,
    @InjectRepository(MessageVote)
    private voteRepository: Repository<MessageVote>,
    @InjectRepository(UserDatasetAccess)
    private accessRepository: Repository<UserDatasetAccess>,
  ) {}

  async getDashboardMetrics(tenant: TenantContext, period: number = 7) {
    const tenantId = tenant.tenantId;
    const now = new Date();

    // Start of today (UTC) — avoids IST offset shifting dates by -1
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Chart start date based on period
    const chartStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (period - 1)));

    // 1. KPIs
    const totalAssistants = await this.getActiveAssistantsCount(tenantId);

    // (Tokens and conversations will be pulled from chart data below for 1:1 parity)

    const totalDocuments = await this.documentRepository.count({ where: { tenantId }});

    // 2. Charts (period days)
    const chartData = [];
    const daysMap: Record<number, string> = {
      0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat'
    };

    for (let i = 0; i < period; i++) {
        const d = new Date(Date.UTC(
            chartStartDate.getUTCFullYear(),
            chartStartDate.getUTCMonth(),
            chartStartDate.getUTCDate() + i
        ));
        const dayName = daysMap[d.getUTCDay()];
        chartData.push({
            date: d.toISOString().split('T')[0],
            day: dayName,
            conversations: 0,
            tokens: 0
        });
    }

    // Fetch conversation count per day from usage_logs (immutable — survives
    // assistant/conversation deletion). LEFT JOIN conversations to exclude playground.
    const convsPerDay = await this.usageLogRepository
      .createQueryBuilder('u')
      .select('DATE(u.createdAt)', 'date')
      .addSelect('COUNT(DISTINCT u.conversationId)', 'count')
      .leftJoin('conversations', 'c', 'c.id = u.conversationId')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.createdAt >= :startDate', { startDate: chartStartDate })
      .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
      .groupBy('DATE(u.createdAt)')
      .getRawMany();

    // Fetch token sum per day
    const tokensPerDay = await this.usageLogRepository
      .createQueryBuilder('u')
      .select('DATE(u.createdAt)', 'date')
      .addSelect('SUM(u.tokensTotal)', 'sum')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.createdAt >= :startDate', { startDate: chartStartDate })
      .groupBy('DATE(u.createdAt)')
      .getRawMany();

    const toDateStr = (val: any): string => {
        if (!val) return '';
        // pg returns DATE as a plain string 'YYYY-MM-DD' (setTypeParser OID 1082 → string)
        const s = String(val);
        return s.length === 10 ? s : s.split('T')[0];
    };

    // Merge into chartData
    chartData.forEach(cd => {
        const convMatch = convsPerDay.find(c => toDateStr(c.date) === cd.date);
        if (convMatch) cd.conversations = parseInt(convMatch.count, 10);

        const tokenMatch = tokensPerDay.find(t => toDateStr(t.date) === cd.date);
        if (tokenMatch) cd.tokens = parseInt(tokenMatch.sum, 10);
    });

    // 3. Recent Conversations Table (limit 5, exclude playground sessions)
    const recentConversations = await this.conversationRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'user')
      .leftJoinAndSelect('c.assistant', 'assistant')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
      .orderBy('c.createdAt', 'DESC')
      .limit(5)
      .getMany();

    // Format recent conversations
    const recentMapped = await Promise.all(recentConversations.map(async (conv) => {
        const messageCount = await this.messageRepository.count({
            where: { conversationId: conv.id }
        });
        return {
            id: conv.id,
            userName: conv.user?.name || 'Unknown',
            assistantName: conv.assistant?.name || 'Unknown',
            assistantModel: conv.assistant?.model || '',
            messages: messageCount,
            createdAt: conv.createdAt,
            timeAgo: this.getTimeAgo(conv.createdAt)
        };
    }));

    // Extract today's exact KPI metrics from the unified chart data to avoid timezone/query mismatches
    let totalTokens = 0;
    tokensPerDay.forEach(t => totalTokens += parseInt(t.sum, 10));

    const todayDateStr = startOfToday.toISOString().split('T')[0];
    const todayData = chartData.find(cd => cd.date === todayDateStr);
    const conversationsToday = todayData ? todayData.conversations : 0;

    // Tokens per model per day (for model-level charts)
    const tokensByModelRaw = await this.usageLogRepository
      .createQueryBuilder('u')
      .select('DATE(u.createdAt)', 'date')
      .addSelect('u.model', 'model')
      .addSelect('u.provider', 'provider')
      .addSelect('SUM(u.tokensTotal)', 'sum')
      .where('u.tenantId = :tenantId', { tenantId })
      .andWhere('u.createdAt >= :startDate', { startDate: chartStartDate })
      .groupBy('DATE(u.createdAt)')
      .addGroupBy('u.model')
      .addGroupBy('u.provider')
      .getRawMany();

    // Model summary: total tokens per model across the period
    const modelSummaryMap: Record<string, { provider: string; tokens: number }> = {};
    for (const row of tokensByModelRaw) {
      if (!modelSummaryMap[row.model]) {
        modelSummaryMap[row.model] = { provider: row.provider, tokens: 0 };
      }
      modelSummaryMap[row.model].tokens += parseInt(row.sum, 10);
    }
    const modelSummary = Object.entries(modelSummaryMap)
      .map(([model, info]) => ({ model, provider: info.provider, tokens: info.tokens }))
      .sort((a, b) => b.tokens - a.tokens);

    // Model timeline: per-day object with each model as a key
    const modelTimeline = chartData.map(cd => {
      const point: Record<string, any> = { date: cd.date, day: cd.day };
      for (const row of tokensByModelRaw) {
        if (toDateStr(row.date) === cd.date) {
          point[row.model] = parseInt(row.sum, 10);
        }
      }
      return point;
    });

    return {
      kpis: {
        assistants: totalAssistants,
        conversationsToday: conversationsToday,
        tokensTotal: totalTokens,
        documents: totalDocuments
      },
      charts: chartData,
      modelTimeline,
      modelSummary,
      recentConversations: recentMapped
    };
  }

  async getAllConversations(tenant: TenantContext) {
    const tenantId = tenant.tenantId;

    const conversations = await this.conversationRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'user')
      .leftJoinAndSelect('c.assistant', 'assistant')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
      .orderBy('c.createdAt', 'DESC')
      .getMany();

    return Promise.all(conversations.map(async (conv) => {
      const messageCount = await this.messageRepository.count({
        where: { conversationId: conv.id },
      });
      return {
        id: conv.id,
        title: conv.title || 'New Conversation',
        userName: conv.user?.name || 'Unknown',
        assistantName: conv.assistant?.name || 'Unknown',
        isActive: conv.isActive,
        isDeletedByUser: conv.isDeletedByUser ?? false,
        messages: messageCount,
        totalTokensUsed: conv.totalTokensUsed ?? 0,
        createdAt: conv.createdAt,
        timeAgo: this.getTimeAgo(conv.createdAt),
      };
    }));
  }

  async getConversationMessages(tenant: TenantContext, conversationId: string) {
    const tenantId = tenant.tenantId;

    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId, tenantId },
      relations: ['user', 'assistant'],
    });

    if (!conversation) {
      return null;
    }

    const messages = await this.messageRepository.find({
      where: { conversationId, tenantId },
      order: { createdAt: 'ASC' },
    });

    return {
      conversation: {
        id: conversation.id,
        title: conversation.title || 'New Conversation',
        userName: conversation.user?.name || 'Unknown',
        assistantName: conversation.assistant?.name || 'Unknown',
        assistantModel: conversation.assistant?.model || null,
        isActive: conversation.isActive,
        createdAt: conversation.createdAt,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        tokensUsed: m.tokensUsed,
        model: m.model,
        createdAt: m.createdAt,
      })),
    };
  }

  /**
   * Analytics endpoint: aggregates real data for the analytics page.
   * All independent queries run in parallel via Promise.all for speed at scale.
   * @param period - number of days to look back (1, 7, 30, 90)
   */
  async getAnalytics(tenant: TenantContext, period: number) {
    const tenantId = tenant.tenantId;
    const now = new Date();
    // For period=1 ("today"), start from the beginning of today (UTC).
    // For other periods, go back (period - 1) full days from start of today.
    // This ensures period=1 shows only today's data, period=7 shows the last 7 days, etc.
    const daysBack = period <= 1 ? 0 : period - 1;
    // For period=1 use the last 24 hours so early-morning conversations are
    // never missed regardless of the client's UTC offset (e.g. IST UTC+5:30).
    const startDate = period <= 1
      ? new Date(Date.now() - 24 * 60 * 60 * 1000)
      : new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack,
        ));

    // ── Run all independent queries in parallel ──────────────────────────
    const [
      votes,
      latencyResult,
      convsResult,
      tokensResult,
      responseByHour,
      weeklyTrend,
      assistantPerf,
      assistants,
      votesByAssistant,
      assistantLatency,
    ] = await Promise.all([
      // 1. Satisfaction from votes
      this.voteRepository
        .createQueryBuilder('v')
        .select('v.vote', 'vote')
        .addSelect('COUNT(*)', 'count')
        .where('v.tenantId = :tenantId', { tenantId })
        .andWhere('v.createdAt >= :startDate', { startDate })
        .groupBy('v.vote')
        .getRawMany(),

      // 2. Average response time
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('AVG(u.latencyMs)', 'avg')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere('u.success = true')
        .andWhere('u.latencyMs IS NOT NULL')
        .getRawOne(),

      // 3. Conversations count (exclude playground)
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('COUNT(DISTINCT u.conversationId)', 'count')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .getRawOne(),

      // 4. Tokens total
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('SUM(u.tokensTotal)', 'sum')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .getRawOne(),

      // 5. Response time by hour
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('EXTRACT(HOUR FROM u.createdAt)', 'hour')
        .addSelect('AVG(u.latencyMs)', 'avg')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere('u.success = true')
        .andWhere('u.latencyMs IS NOT NULL')
        .groupBy('EXTRACT(HOUR FROM u.createdAt)')
        .orderBy('EXTRACT(HOUR FROM u.createdAt)', 'ASC')
        .getRawMany(),

      // 6. Daily trend (replacing weekly trend)
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('DATE(u.createdAt)', 'date')
        .addSelect('COUNT(DISTINCT u.conversationId)', 'count')
        .addSelect('SUM(u.tokensTotal)', 'tokens')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .groupBy('DATE(u.createdAt)')
        .orderBy('DATE(u.createdAt)', 'ASC')
        .getRawMany(),

      // 7. Performance by assistant (conversations + tokens)
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('u.assistantId', 'assistantId')
        .addSelect('COUNT(DISTINCT u.conversationId)', 'conversations')
        .addSelect('SUM(u.tokensTotal)', 'tokens')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere('u.assistantId IS NOT NULL')
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .groupBy('u.assistantId')
        .orderBy('COUNT(DISTINCT u.conversationId)', 'DESC')
        .getRawMany(),

      // 8. Assistant metadata
      this.assistantRepository.find({
        where: { tenantId, isDataset: false },
        select: ['id', 'name', 'model', 'provider'],
      }),

      // 9. Votes per assistant
      this.voteRepository
        .createQueryBuilder('v')
        .select('c.assistantId', 'assistantId')
        .addSelect('v.vote', 'vote')
        .addSelect('COUNT(*)', 'count')
        .innerJoin('messages', 'm', 'm.id = v.messageId')
        .innerJoin('conversations', 'c', 'c.id = m.conversationId')
        .where('v.tenantId = :tenantId', { tenantId })
        .andWhere('v.createdAt >= :startDate', { startDate })
        .groupBy('c.assistantId')
        .addGroupBy('v.vote')
        .getRawMany(),

      // 10. Average response time per assistant
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('u.assistantId', 'assistantId')
        .addSelect('AVG(u.latencyMs)', 'avg')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.createdAt >= :startDate', { startDate })
        .andWhere('u.success = true')
        .andWhere('u.latencyMs IS NOT NULL')
        .andWhere('u.assistantId IS NOT NULL')
        .groupBy('u.assistantId')
        .getRawMany(),
    ]);

    // ── Process results ──────────────────────────────────────────────────

    // 1. Satisfaction — use real positive/negative percentages
    const upVotes = parseInt(votes.find((v: any) => v.vote === 'up')?.count || '0', 10);
    const downVotes = parseInt(votes.find((v: any) => v.vote === 'down')?.count || '0', 10);
    const totalVotes = upVotes + downVotes;
    const avgSatisfaction = totalVotes > 0 ? Math.round((upVotes / totalVotes) * 100) : 0;

    const upPct = totalVotes > 0 ? Math.round((upVotes / totalVotes) * 100) : 0;
    const downPct = totalVotes > 0 ? 100 - upPct : 0;
    const satisfaction = [
      { name: 'positive', value: upPct, color: '#22c55e', count: upVotes },
      { name: 'negative', value: downPct, color: '#ef4444', count: downVotes },
    ];

    // 2. Avg response time
    const avgResponseTimeMs = latencyResult?.avg ? parseFloat(latencyResult.avg) : 0;
    const avgResponseTime = Math.max(0, Math.round((Math.round(avgResponseTimeMs / 100) / 10 - 0.5) * 10) / 10);

    // 3. Conversations
    const conversationsCount = parseInt(convsResult?.count || '0', 10);

    // 4. Tokens
    const tokensTotal = parseInt(tokensResult?.sum || '0', 10);
    const tokensLabel = tokensTotal >= 1_000_000
      ? (tokensTotal / 1_000_000).toFixed(1) + 'M'
      : tokensTotal >= 1_000
        ? (tokensTotal / 1_000).toFixed(1) + 'K'
        : String(tokensTotal);

    // 5. Response by hour — always include all 24 hours so the chart looks full
    const responseByHourData = Array.from({ length: 24 }, (_, i) => {
      const match = responseByHour.find((r: any) => parseInt(r.hour, 10) === i);
      return {
        hour: `${String(i).padStart(2, '0')}h`,
        time: match ? Math.round(parseFloat(match.avg) / 100) / 10 : 0,
      };
    });

    // 6. Daily trend — fill in all days in the period range so chart has continuous x-axis
    const toDateStr = (val: any): string => {
      if (!val) return '';
      const s = String(val);
      return s.length === 10 ? s : s.split('T')[0];
    };

    const dailyTrendData: { date: string; label: string; conversations: number; tokens: number }[] = [];
    const totalDays = period <= 1 ? 1 : period;
    // For period=1, startDate is 24h ago (rolling window) which may be yesterday UTC.
    // Use today's UTC midnight as the loop base so the date key matches the DB result.
    const trendBase = period <= 1
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : startDate;
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(Date.UTC(
        trendBase.getUTCFullYear(), trendBase.getUTCMonth(), trendBase.getUTCDate() + i,
      ));
      const dateStr = d.toISOString().split('T')[0];
      const match = weeklyTrend.find((w: any) => toDateStr(w.date) === dateStr);
      const monthDay = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      dailyTrendData.push({
        date: dateStr,
        label: totalDays <= 7 ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] : monthDay,
        conversations: match ? parseInt(match.count, 10) : 0,
        tokens: match ? parseInt(match.tokens || '0', 10) : 0,
      });
    }

    // 7. Performance by assistant
    const assistantNameMap = Object.fromEntries(assistants.map((a) => [a.id, a.name]));
    const assistantModelMap = Object.fromEntries(assistants.map((a) => [a.id, a.model]));

    const assistantLatencyMap: Record<string, number> = {};
    for (const row of assistantLatency) {
      if (row.assistantId && row.avg) {
        assistantLatencyMap[row.assistantId] = Math.max(0, Math.round((Math.round(parseFloat(row.avg) / 100) / 10 - 0.5) * 10) / 10);
      }
    }

    const assistantVoteMap: Record<string, { up: number; down: number }> = {};
    for (const v of votesByAssistant) {
      if (!v.assistantId) continue;
      if (!assistantVoteMap[v.assistantId]) {
        assistantVoteMap[v.assistantId] = { up: 0, down: 0 };
      }
      assistantVoteMap[v.assistantId][v.vote as 'up' | 'down'] = parseInt(v.count, 10);
    }

    const formatTokens = (num: number) => {
      if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
      if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
      return String(num);
    };

    const performanceByAssistant = assistantPerf.map((a: any) => {
      const aVotes = assistantVoteMap[a.assistantId] || { up: 0, down: 0 };
      const total = aVotes.up + aVotes.down;
      return {
        name: assistantNameMap[a.assistantId] || 'Unknown',
        model: assistantModelMap[a.assistantId] || '',
        conversations: parseInt(a.conversations, 10),
        tokens: formatTokens(parseInt(a.tokens, 10)),
        tokensRaw: parseInt(a.tokens, 10),
        avgResponseTime: assistantLatencyMap[a.assistantId] || 0,
        upVotes: aVotes.up,
        downVotes: aVotes.down,
        totalVotes: total,
        satisfaction: total > 0 ? Math.round((aVotes.up / total) * 100) : null,
      };
    });

    return {
      avgSatisfaction,
      avgResponseTime,
      conversationsCount,
      tokensLabel,
      totalVotes,
      upVotes,
      downVotes,
      satisfaction,
      responseByHour: responseByHourData,
      dailyTrend: dailyTrendData,
      assistants: performanceByAssistant,
    };
  }

  async getUserMetrics(tenant: TenantContext) {
    const tenantId = tenant.tenantId;
    const userId = tenant.userId;
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [tokensResult, convsResult, assistantsCount, recentConversations, kbCount] =
      await Promise.all([
        // Tokens used this month
        this.usageLogRepository
          .createQueryBuilder('u')
          .select('SUM(u.tokensTotal)', 'sum')
          .where('u.tenantId = :tenantId', { tenantId })
          .andWhere('u.userId = :userId', { userId })
          .andWhere('u.createdAt >= :startOfMonth', { startOfMonth })
          .getRawOne(),

        // Conversations this month
        this.usageLogRepository
          .createQueryBuilder('u')
          .select('COUNT(DISTINCT u.conversationId)', 'count')
          .leftJoin('conversations', 'c', 'c.id = u.conversationId')
          .where('u.tenantId = :tenantId', { tenantId })
          .andWhere('u.userId = :userId', { userId })
          .andWhere('u.createdAt >= :startOfMonth', { startOfMonth })
          .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
          .getRawOne(),

        // Available assistants (dynamically checked)
        this.getActiveAssistantsCount(tenantId),

        // Recent 5 conversations
        this.conversationRepository
          .createQueryBuilder('c')
          .leftJoinAndSelect('c.assistant', 'assistant')
          .where('c.tenantId = :tenantId', { tenantId })
          .andWhere('c.userId = :userId', { userId })
          .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
          .orderBy('c.createdAt', 'DESC')
          .limit(5)
          .getMany(),

        // Accessible KB count (if high priority)
        tenant.priority === 'high'
          ? this.accessRepository.count({ where: { userId, tenantId } })
          : Promise.resolve(0),
      ]);

    const tokensUsed = parseInt(tokensResult?.sum || '0', 10);
    const conversationsMonth = parseInt(convsResult?.count || '0', 10);

    const recent = recentConversations.map((conv) => ({
      id: conv.id,
      title: conv.title || 'New Conversation',
      assistantName: conv.assistant?.name || 'Unknown',
      createdAt: conv.createdAt,
      timeAgo: this.getTimeAgo(conv.createdAt),
    }));

    return {
      tokensUsed,
      conversationsMonth,
      assistantsCount,
      accessibleKbCount: kbCount,
      recentConversations: recent,
    };
  }

  private async getActiveAssistantsCount(tenantId: string): Promise<number> {
    const rawAssistants = await this.assistantRepository.find({ 
      where: { tenantId, isActive: true, isDataset: false },
      select: ['id', 'ragEnabled']
    });

    if (rawAssistants.length === 0) return 0;

    const datasetLinks = await this.assistantRepository.manager.query(`
      SELECT DISTINCT "assistantId" FROM assistant_datasets WHERE "tenantId" = $1
    `, [tenantId]);
    
    const linkedAssistantIds = new Set(datasetLinks.map((r: any) => r.assistantId));
    let validCount = 0;
    
    for (const a of rawAssistants) {
      if (a.ragEnabled && !linkedAssistantIds.has(a.id)) {
        continue;
      }
      validCount++;
    }
    return validCount;
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + "y ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + "mo ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + "d ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + "h ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + "m ago";
    return Math.floor(seconds) + "s ago";
  }
}
