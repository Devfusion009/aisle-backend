import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BaseRepository, DateRange } from './base.repository';
import { MessageVote, VoteType } from '../entities/message-vote.entity';

export interface VoteAggregation {
  total: number;
  up: number;
  down: number;
  satisfactionPct: number; // 0-100
}

@Injectable()
export class VoteRepo extends BaseRepository<MessageVote> {
  constructor(
    @InjectRepository(MessageVote) repo: Repository<MessageVote>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find a user's vote on a specific message */
  async findUserVote(
    tenantId: string,
    messageId: string,
    userId: string,
  ): Promise<MessageVote | null> {
    return this.repo.findOne({
      where: { tenantId, messageId, userId },
    });
  }

  /**
   * Upsert a vote: create if none exists, update if it does.
   * Pass null to remove the vote.
   */
  async upsertVote(
    tenantId: string,
    messageId: string,
    userId: string,
    vote: VoteType | null,
  ): Promise<void> {
    const existing = await this.findUserVote(tenantId, messageId, userId);

    if (vote === null) {
      if (existing) await this.repo.remove(existing);
      return;
    }

    if (existing) {
      existing.vote = vote;
      await this.repo.save(existing);
    } else {
      const entity = this.repo.create({ tenantId, messageId, userId, vote });
      await this.repo.save(entity);
    }
  }

  /** Aggregate satisfaction for a tenant within a date range */
  async aggregate(
    tenantId: string,
    range?: DateRange,
  ): Promise<VoteAggregation> {
    const qb = this.repo
      .createQueryBuilder('v')
      .select('v.vote', 'vote')
      .addSelect('COUNT(*)', 'count')
      .where('v.tenantId = :tenantId', { tenantId })
      .groupBy('v.vote');

    if (range) this.applyDateRange(qb, 'v', range);

    const rows: { vote: string; count: string }[] = await qb.getRawMany();

    let up = 0;
    let down = 0;
    for (const r of rows) {
      if (r.vote === VoteType.UP) up = parseInt(r.count, 10);
      if (r.vote === VoteType.DOWN) down = parseInt(r.count, 10);
    }
    const total = up + down;
    return {
      total,
      up,
      down,
      satisfactionPct: total > 0 ? Math.round((up / total) * 100) : 0,
    };
  }

  /** Aggregate votes per assistant */
  async aggregateByAssistant(
    tenantId: string,
    range?: DateRange,
  ): Promise<
    {
      assistantId: string;
      vote: string;
      count: number;
    }[]
  > {
    const qb = this.repo
      .createQueryBuilder('v')
      .innerJoin('messages', 'm', 'm.id = v.messageId')
      .innerJoin('conversations', 'c', 'c.id = m.conversationId')
      .select('c.assistantId', 'assistantId')
      .addSelect('v.vote', 'vote')
      .addSelect('COUNT(*)', 'count')
      .where('v.tenantId = :tenantId', { tenantId })
      .groupBy('c.assistantId')
      .addGroupBy('v.vote');

    if (range) this.applyDateRange(qb, 'v', range);

    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      assistantId: r.assistantId,
      vote: r.vote,
      count: parseInt(r.count, 10),
    }));
  }
}
