import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, DeepPartial } from 'typeorm';
import { BaseRepository } from './base.repository';
import { Message, MessageRole } from '../entities/message.entity';

@Injectable()
export class MessageRepo extends BaseRepository<Message> {
  constructor(
    @InjectRepository(Message) repo: Repository<Message>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Get all messages for a conversation, ordered chronologically */
  async findByConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<Message[]> {
    return this.repo.find({
      where: { tenantId, conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  /** Get the N most recent messages (for LLM context building) */
  async getRecentHistory(
    tenantId: string,
    conversationId: string,
    limit: number,
  ): Promise<Message[]> {
    const msgs = await this.repo.find({
      where: { tenantId, conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return msgs.reverse(); // return in chronological order
  }

  /** Save a user + assistant message pair atomically */
  async saveMessagePair(
    tenantId: string,
    userMsg: DeepPartial<Message>,
    assistantMsg: DeepPartial<Message>,
    manager?: EntityManager,
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const run = async (mgr: EntityManager) => {
      const r = mgr.getRepository(Message);
      const user = r.create({
        tenantId,
        role: MessageRole.USER,
        ...userMsg,
      });
      const savedUser = await r.save(user);

      const assistant = r.create({
        tenantId,
        role: MessageRole.ASSISTANT,
        ...assistantMsg,
      });
      const savedAssistant = await r.save(assistant);

      return { userMessage: savedUser, assistantMessage: savedAssistant };
    };

    if (manager) return run(manager);
    return this.ds.transaction(run);
  }

  /** Count messages in a conversation */
  async countByConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    return this.repo.count({ where: { tenantId, conversationId } });
  }

  /** Count all messages for a user */
  async countByUser(tenantId: string, userId: string): Promise<number> {
    return this.repo
      .createQueryBuilder('m')
      .innerJoin('conversations', 'c', 'c.id = m.conversationId')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('c.userId = :userId', { userId })
      .getCount();
  }

  /** Delete all messages in a conversation */
  async deleteByConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await this.repo.delete({ tenantId, conversationId });
  }
}
