import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  BaseRepository,
  PLAYGROUND_PREFIX,
  PaginatedResult,
  PaginationOpts,
} from './base.repository';
import { Conversation } from '../entities/conversation.entity';

@Injectable()
export class ConversationRepo extends BaseRepository<Conversation> {
  constructor(
    @InjectRepository(Conversation) repo: Repository<Conversation>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /**
   * Find conversations visible to a user
   * (excludes soft-deleted and playground sessions)
   */
  async findForUser(
    tenantId: string,
    userId: string,
  ): Promise<Conversation[]> {
    return this.repo
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.userId = :userId', { userId })
      .andWhere('c.isDeletedByUser = false')
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      )
      .orderBy('c.isPinned', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Find all non-playground conversations for a tenant (admin view)
   */
  async findAllReal(tenantId: string): Promise<Conversation[]> {
    return this.repo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'u')
      .leftJoinAndSelect('c.assistant', 'a')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      )
      .orderBy('c.createdAt', 'DESC')
      .getMany();
  }

  /** Paginated conversations (admin view with relations) */
  async findAllRealPaginated(
    tenantId: string,
    pagination: PaginationOpts,
  ): Promise<PaginatedResult<Conversation>> {
    const page = Math.max(1, pagination.page ?? 1);
    const limit = Math.min(Math.max(1, pagination.limit ?? 20), 200);

    const qb = this.repo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'u')
      .leftJoinAndSelect('c.assistant', 'a')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      )
      .orderBy('c.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Find conversation with messages loaded */
  async findWithMessages(
    tenantId: string,
    id: string,
  ): Promise<Conversation | null> {
    return this.repo.findOne({
      where: { id, tenantId },
      relations: { messages: true, assistant: true },
      order: { messages: { createdAt: 'ASC' } },
    });
  }

  /** Count real conversations per assistant */
  async countByAssistant(
    tenantId: string,
    assistantId: string,
  ): Promise<number> {
    return this.repo
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.assistantId = :assistantId', { assistantId })
      .andWhere(
        `(c.title IS NULL OR c.title NOT LIKE :pgPrefix)`,
        { pgPrefix: `${PLAYGROUND_PREFIX}%` },
      )
      .getCount();
  }

  /** Count conversations for a specific user */
  async countByUser(tenantId: string, userId: string): Promise<number> {
    return this.repo.count({ where: { tenantId, userId } });
  }

  // ── Flags ──────────────────────────────────────────────────────────

  /** Soft-delete a conversation (hide from user, preserve for admin) */
  async softDelete(tenantId: string, id: string): Promise<void> {
    await this.patch(tenantId, id, { isDeletedByUser: true } as any);
  }

  /** Toggle pin */
  async togglePin(tenantId: string, id: string): Promise<boolean> {
    const conv = await this.findByIdOrFail(tenantId, id);
    const next = !conv.isPinned;
    await this.repo.update({ id, tenantId }, { isPinned: next });
    return next;
  }

  /** Toggle archive */
  async toggleArchive(tenantId: string, id: string): Promise<boolean> {
    const conv = await this.findByIdOrFail(tenantId, id);
    const next = !conv.isArchived;
    await this.repo.update({ id, tenantId }, { isArchived: next });
    return next;
  }

  /** Increment token counters */
  async addTokens(
    tenantId: string,
    id: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({
        totalTokensUsed: () =>
          `"totalTokensUsed" + ${inputTokens + outputTokens}`,
      })
      .where('id = :id AND "tenantId" = :tenantId', { id, tenantId })
      .execute();
  }

  /** Update title */
  async setTitle(
    tenantId: string,
    id: string,
    title: string,
  ): Promise<void> {
    await this.repo.update({ id, tenantId }, { title });
  }
}
