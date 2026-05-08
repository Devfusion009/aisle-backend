import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message, MessageRole, MessageAttachment } from '../../database/entities/message.entity';
import { MessageVote, VoteType } from '../../database/entities/message-vote.entity';
import { CreateConversationDto, ConversationResponse, MessageResponse } from './dto/conversation.dto';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { AssistantsService } from '../assistants/assistants.service';
import { SessionService, SessionState } from './session.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

/**
 * Conversations Service
 * Manages conversation CRUD and message history.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(MessageVote)
    private readonly voteRepository: Repository<MessageVote>,
    private readonly assistantsService: AssistantsService,
    private readonly sessionService: SessionService,
    private readonly dataSource: DataSource,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) { }

  /**
   * Create a new conversation
   */
  async create(tenant: TenantContext, dto: CreateConversationDto): Promise<ConversationResponse> {
    // Verify assistant exists and belongs to tenant
    const assistant = await this.assistantsService.findOneEntity(tenant.tenantId, dto.assistantId);

    // Create conversation
    const conversation = this.conversationRepository.create({
      tenantId: tenant.tenantId,
      assistantId: dto.assistantId,
      userId: tenant.userId,
      title: dto.title,
    });

    let saved: Conversation;
    try {
      saved = await this.conversationRepository.save(conversation);
    } catch (error) {
      this.logger.error(`Failed to create conversation for user ${tenant.userId}`, error);
      throw new InternalServerErrorException('Failed to create conversation');
    }

    this.webhookDispatcher.emit(tenant.tenantId, 'conversation.created', {
      conversationId: saved.id,
      assistantId: dto.assistantId,
      userId: tenant.userId,
      title: saved.title,
    });

    // Initialize Redis session (best-effort — chat will recreate if needed)
    try {
      const sessionState: SessionState = {
        conversationId: saved.id,
        tenantId: tenant.tenantId,
        assistantId: dto.assistantId,
        userId: tenant.userId,
        recentMessages: [],
        lastActivity: Date.now(),
      };
      await this.sessionService.createSession(sessionState);
    } catch (error) {
      this.logger.warn(
        `Failed to create Redis session for conversation ${saved.id}. Session will be recreated on first chat.`,
        error,
      );
    }

    return this.toConversationResponse(saved, assistant.name);
  }

  /**
   * Get all conversations for a user (excludes soft-deleted and playground sessions)
   */
  async findAll(tenant: TenantContext): Promise<ConversationResponse[]> {
    const conversations = await this.conversationRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.assistant', 'assistant')
      .where('c.tenantId = :tenantId', { tenantId: tenant.tenantId })
      .andWhere('c.userId = :userId', { userId: tenant.userId })
      .andWhere('c.isDeletedByUser = :deleted', { deleted: false })
      .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
      .orderBy('c.createdAt', 'DESC')
      .getMany();

    return conversations.map((c) => this.toConversationResponse(c, c.assistant?.name || 'Unknown'));
  }

  /**
   * Get a specific conversation (returns 404 for soft-deleted conversations).
   * Scoped to the requester's userId to prevent IDOR — a user can only access
   * their own conversations even within the same tenant.
   */
  async findOne(tenant: TenantContext, id: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: {
        id,
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        isDeletedByUser: false,
      },
      relations: ['assistant'],
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation with ID "${id}" not found`);
    }

    return conversation;
  }

  /**
   * Update a conversation (e.g., rename title)
   */
  async update(tenant: TenantContext, id: string, title?: string): Promise<ConversationResponse> {
    const conversation = await this.findOne(tenant, id);
    if (title !== undefined) {
      conversation.title = title;
      await this.conversationRepository.save(conversation);
    }
    return this.toConversationResponse(conversation, conversation.assistant?.name || 'Unknown');
  }

  /**
   * Soft-delete a conversation: hides it from the user's sidebar but preserves it for admin view.
   */
  async delete(tenant: TenantContext, id: string): Promise<void> {
    const conversation = await this.findOne(tenant, id);

    // Clear redis session if exists (best-effort)
    try {
      await this.sessionService.deleteSession(id);
    } catch (err) {
      this.logger.warn(`Failed to clear Redis session for conversation ${id}`, err);
    }

    try {
      conversation.isDeletedByUser = true;
      await this.conversationRepository.save(conversation);
    } catch (error) {
      this.logger.error(`Failed to soft-delete conversation ${id}`, error);
      throw new InternalServerErrorException('Failed to delete conversation');
    }
  }

  /**
   * Toggle pin status of a conversation
   */
  async togglePin(tenant: TenantContext, id: string): Promise<ConversationResponse> {
    const conversation = await this.findOne(tenant, id);
    conversation.isPinned = !conversation.isPinned;
    await this.conversationRepository.save(conversation);
    return this.toConversationResponse(conversation, conversation.assistant?.name || 'Unknown');
  }

  /**
   * Toggle archive status of a conversation
   */
  async toggleArchive(tenant: TenantContext, id: string): Promise<ConversationResponse> {
    const conversation = await this.findOne(tenant, id);
    const wasArchived = conversation.isArchived;
    conversation.isArchived = !conversation.isArchived;
    // Unpin if archiving
    if (conversation.isArchived) {
      conversation.isPinned = false;
    }
    await this.conversationRepository.save(conversation);

    if (!wasArchived && conversation.isArchived) {
      this.webhookDispatcher.emit(tenant.tenantId, 'conversation.closed', {
        conversationId: conversation.id,
        title: conversation.title,
      });
    }

    return this.toConversationResponse(conversation, conversation.assistant?.name || 'Unknown');
  }

  /**
   * Get messages for a conversation (includes current user's votes)
   */
  async getMessages(tenant: TenantContext, conversationId: string): Promise<MessageResponse[]> {
    // Verify conversation access
    await this.findOne(tenant, conversationId);

    const messages = await this.messageRepository.find({
      where: { tenantId: tenant.tenantId, conversationId },
      order: { createdAt: 'ASC' },
    });

    // Fetch all votes by this user for messages in this conversation
    const messageIds = messages.map((m) => m.id);
    let votesMap: Record<string, VoteType> = {};
    if (messageIds.length > 0) {
      const votes = await this.voteRepository
        .createQueryBuilder('v')
        .where('v.userId = :userId', { userId: tenant.userId })
        .andWhere('v.messageId IN (:...messageIds)', { messageIds })
        .getMany();
      votesMap = Object.fromEntries(votes.map((v) => [v.messageId, v.vote]));
    }

    return messages.map((m) => this.toMessageResponse(m, votesMap[m.id] || null));
  }

  /**
   * Vote on a message (thumbs up/down). Pass null to remove vote.
   */
  async voteMessage(
    tenant: TenantContext,
    messageId: string,
    vote: 'up' | 'down' | null,
  ): Promise<{ messageId: string; vote: 'up' | 'down' | null }> {
    // Verify the message exists, belongs to the tenant, AND lives in a
    // conversation owned by the requesting user. Without the userId join
    // any tenant member could vote on another user's messages (IDOR).
    const message = await this.messageRepository
      .createQueryBuilder('m')
      .innerJoin(Conversation, 'c', 'c.id = m.conversationId')
      .where('m.id = :messageId', { messageId })
      .andWhere('m.tenantId = :tenantId', { tenantId: tenant.tenantId })
      .andWhere('c.userId = :userId', { userId: tenant.userId })
      .andWhere('c.isDeletedByUser = :deleted', { deleted: false })
      .getOne();
    if (!message) {
      throw new NotFoundException(`Message with ID "${messageId}" not found`);
    }

    if (vote === null) {
      // Remove existing vote
      await this.voteRepository.delete({
        messageId,
        userId: tenant.userId,
      });
      return { messageId, vote: null };
    }

    // Upsert vote
    const existing = await this.voteRepository.findOne({
      where: { messageId, userId: tenant.userId },
    });

    if (existing) {
      existing.vote = vote as VoteType;
      await this.voteRepository.save(existing);
    } else {
      const newVote = this.voteRepository.create({
        tenantId: tenant.tenantId,
        messageId,
        userId: tenant.userId,
        vote: vote as VoteType,
      });
      await this.voteRepository.save(newVote);
    }

    return { messageId, vote };
  }

  /**
   * Save a message to the database
   */
  async saveMessage(
    tenantId: string,
    conversationId: string,
    role: MessageRole,
    content: string,
    tokensUsed: number = 0,
    model?: string,
    contextChunks?: any[],
    attachments?: MessageAttachment[] | null,
  ): Promise<Message> {
    try {
      const message = this.messageRepository.create({
        tenantId,
        conversationId,
        role,
        content,
        tokensUsed,
        model,
        contextChunks,
        attachments: attachments && attachments.length > 0 ? attachments : null,
      });

      return await this.messageRepository.save(message);
    } catch (error) {
      this.logger.error(
        `Failed to save ${role} message for conversation ${conversationId}`,
        error,
      );
      throw new InternalServerErrorException('Failed to save message');
    }
  }

  /**
   * Save a user + assistant message pair and update token count atomically.
   * All three operations run in a single DB transaction — if any fails, all roll back.
   */
  async saveMessagePair(
    tenantId: string,
    conversationId: string,
    userContent: string,
    userTokens: number,
    assistantContent: string,
    assistantTokens: number,
    model?: string,
    contextChunks?: any[],
    userAttachments?: MessageAttachment[] | null,
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const userMsg = manager.create(Message, {
          tenantId,
          conversationId,
          role: MessageRole.USER,
          content: userContent,
          tokensUsed: userTokens,
          attachments:
            userAttachments && userAttachments.length > 0 ? userAttachments : null,
        });
        const savedUser = await manager.save(userMsg);

        const assistantMsg = manager.create(Message, {
          tenantId,
          conversationId,
          role: MessageRole.ASSISTANT,
          content: assistantContent,
          tokensUsed: assistantTokens,
          model,
          contextChunks,
        });
        const savedAssistant = await manager.save(assistantMsg);

        // Update token count within the same transaction
        const totalTokens = userTokens + assistantTokens;
        await manager.increment(Conversation, { id: conversationId }, 'totalTokensUsed', totalTokens);

        return { userMessage: savedUser, assistantMessage: savedAssistant };
      });
    } catch (error) {
      this.logger.error(
        `Failed to save message pair for conversation ${conversationId}`,
        error,
      );
      throw new InternalServerErrorException('Failed to save messages');
    }
  }

  /**
   * Update conversation token count
   */
  async updateTokenCount(conversationId: string, tokensUsed: number): Promise<void> {
    try {
      await this.conversationRepository.increment(
        { id: conversationId },
        'totalTokensUsed',
        tokensUsed,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update token count for conversation ${conversationId}`,
        error,
      );
      // Non-critical: log but don't throw to avoid disrupting chat flow
    }
  }

  /**
   * Get recent messages for context building
   */
  async getRecentMessages(conversationId: string, limit: number = 10): Promise<Message[]> {
    return this.messageRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  private toConversationResponse(conversation: Conversation, assistantName: string): ConversationResponse {
    return {
      id: conversation.id,
      assistantId: conversation.assistantId as string,
      assistantName,
      userId: conversation.userId,
      title: conversation.title,
      totalTokensUsed: conversation.totalTokensUsed,
      isPinned: conversation.isPinned ?? false,
      isArchived: conversation.isArchived ?? false,
      createdAt: conversation.createdAt,
    };
  }

  private toMessageResponse(message: Message, vote: 'up' | 'down' | null = null): MessageResponse {
    return {
      id: message.id,
      role: message.role as 'user' | 'assistant' | 'system',
      content: message.content,
      tokensUsed: message.tokensUsed,
      model: message.model,
      vote,
      createdAt: message.createdAt,
      attachments:
        message.attachments && message.attachments.length > 0
          ? message.attachments
          : undefined,
    };
  }

  /**
   * Enable public sharing for a conversation.
   * Generates a unique shareToken (once) and sets isShared = true.
   * The owner can call this multiple times — the token is stable.
   */
  async enableShare(tenant: TenantContext, id: string): Promise<{ shareToken: string }> {
    const conversation = await this.conversationRepository.findOne({
      where: { id, tenantId: tenant.tenantId, userId: tenant.userId, isDeletedByUser: false },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (!conversation.shareToken) {
      const { randomUUID } = await import('crypto');
      conversation.shareToken = randomUUID();
    }
    conversation.isShared = true;
    await this.conversationRepository.save(conversation);

    this.logger.log(`Conversation ${id} shared by user ${tenant.userId}`);
    return { shareToken: conversation.shareToken };
  }

  /**
   * Fetch a publicly shared conversation by its shareToken.
   * Returns only user/assistant messages (no system prompts).
   * Does NOT require authentication — called from the public API.
   */
  async getPublicShare(shareToken: string): Promise<{
    title: string;
    assistantName: string | null;
    messages: { id: string; role: string; content: string; createdAt: Date }[];
  }> {
    const conversation = await this.conversationRepository.findOne({
      where: { shareToken, isShared: true },
      relations: ['assistant'],
    });
    if (!conversation) throw new NotFoundException('Shared conversation not found or access has been revoked');

    const messages = await this.messageRepository.find({
      where: { conversationId: conversation.id, tenantId: conversation.tenantId },
      order: { createdAt: 'ASC' },
    });

    return {
      title: conversation.title || 'Shared Conversation',
      assistantName: conversation.assistant?.name ?? null,
      messages: messages
        .filter((m) => m.role !== MessageRole.SYSTEM)
        .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })),
    };
  }
}
