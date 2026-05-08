import { Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { hashPassword } from '../../common/utils/password.util';
import { User, UserPriority } from '../../database/entities/user.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { getPlanLimits } from '../../common/constants/plan-limits';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { Message } from '../../database/entities/message.entity';
import { MessageVote } from '../../database/entities/message-vote.entity';
import { TenantContext, UserRole } from '../../common/interfaces/tenant-context.interface';
import { KbPermissionService } from '../knowledge/kb-permission.service';

@Injectable()
export class TenantUsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(UserDatasetAccess)
    private readonly accessRepository: Repository<UserDatasetAccess>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(UsageLog)
    private readonly usageLogRepository: Repository<UsageLog>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(MessageVote)
    private readonly voteRepository: Repository<MessageVote>,
    private readonly dataSource: DataSource,
    private readonly kbPermissions: KbPermissionService,
  ) {}

  async findAll(tenant: TenantContext) {
    const users = await this.userRepository.find({
      where: { tenantId: tenant.tenantId },
      order: { createdAt: 'DESC' },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      priority: u.priority,
      isActive: u.isActive,
      emailVerified: u.emailVerified,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    }));
  }

  async create(
    tenant: TenantContext,
    dto: { name: string; email: string; password: string; role?: UserRole; priority?: UserPriority },
  ) {
    // Enforce user limit
    const tenantEntity = await this.tenantRepository.findOne({ where: { id: tenant.tenantId } });
    if (!tenantEntity) throw new NotFoundException('Tenant not found');

    const maxUsers = getPlanLimits(tenantEntity.plan).maxUsers;
    // Exclude TENANT_OWNER from the count — owner is a mandatory account and does not consume a plan seat
    const currentUsers = await this.userRepository.count({
      where: { tenantId: tenant.tenantId, role: In([UserRole.TENANT_ADMIN, UserRole.EDITOR, UserRole.USER]) },
    });
    if (currentUsers >= maxUsers) {
      throw new ForbiddenException(`Plan limit reached (${maxUsers} users). Upgrade to add more.`);
    }

    // Each email can hold only one role per organization
    const existingInOrg = await this.userRepository.findOne({
      where: { email: dto.email, tenantId: tenant.tenantId },
    });
    if (existingInOrg) {
      throw new ConflictException(
        'This email already has a role in this organization. Each email can only be assigned one role per organization.',
      );
    }
    // Each email is globally unique across the platform
    const existingGlobal = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existingGlobal) {
      throw new ConflictException('This email is already registered with another organization.');
    }

    const passwordHash = await hashPassword(dto.password);
    const user = this.userRepository.create({
      tenantId: tenant.tenantId,
      email: dto.email,
      passwordHash,
      name: dto.name,
      role: dto.role || UserRole.USER,
      priority: dto.priority || UserPriority.LOW,
    });
    const saved = await this.userRepository.save(user);

    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      role: saved.role,
      priority: saved.priority,
      isActive: saved.isActive,
      emailVerified: saved.emailVerified,
      createdAt: saved.createdAt,
    };
  }

  async update(
    tenant: TenantContext,
    userId: string,
    dto: { name?: string; role?: UserRole; priority?: UserPriority; isActive?: boolean },
  ) {
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: tenant.tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    // Use a transaction to ensure priority downgrade + access revocation are atomic
    const saved = await this.dataSource.transaction(async (manager) => {
      if (dto.name !== undefined) user.name = dto.name;
      if (dto.role !== undefined) user.role = dto.role;
      if (dto.priority !== undefined) {
        user.priority = dto.priority;
        // If downgrading to LOW, remove all dataset access atomically
        if (dto.priority === UserPriority.LOW) {
          await manager.delete(UserDatasetAccess, { userId, tenantId: tenant.tenantId });
          this.kbPermissions.invalidate(userId, tenant.tenantId);
        }
      }
      if (dto.isActive !== undefined) user.isActive = dto.isActive;

      return manager.save(user);
    });

    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      role: saved.role,
      priority: saved.priority,
      isActive: saved.isActive,
      emailVerified: saved.emailVerified,
      lastLoginAt: saved.lastLoginAt,
      createdAt: saved.createdAt,
    };
  }

  async remove(tenant: TenantContext, userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: tenant.tenantId },
    });
    if (!user) throw new NotFoundException('User not found');
    // Prevent self-deletion
    if (user.id === tenant.userId) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    // Prevent tenant admin from deleting tenant owner (owner is higher authority)
    if (user.role === UserRole.TENANT_OWNER && tenant.role === UserRole.TENANT_ADMIN) {
      throw new ForbiddenException('Tenant admins cannot delete the tenant owner.');
    }
    await this.userRepository.remove(user);
  }

  async getDatasetAccess(tenant: TenantContext, userId: string): Promise<string[]> {
    const records = await this.accessRepository.find({
      where: { userId, tenantId: tenant.tenantId },
    });
    return records.map((r) => r.datasetId);
  }

  async setDatasetAccess(tenant: TenantContext, userId: string, datasetIds: string[]) {
    // Verify user exists and is HIGH priority
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: tenant.tenantId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.priority !== UserPriority.HIGH) {
      throw new ForbiddenException('Only high-priority users can have dataset access.');
    }

    // Delete old + insert new access records atomically in a transaction
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(UserDatasetAccess, { userId, tenantId: tenant.tenantId });

      if (datasetIds.length > 0) {
        const records = datasetIds.map((datasetId) =>
          manager.create(UserDatasetAccess, {
            userId,
            datasetId,
            tenantId: tenant.tenantId,
            grantedBy: tenant.userId,
          }),
        );
        await manager.save(records);
      }
    });
    this.kbPermissions.invalidate(userId, tenant.tenantId);

    return { datasetIds };
  }

  async getUserDetails(tenant: TenantContext, userId: string) {
    const tenantId = tenant.tenantId;

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const thirtyDaysAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

    const [
      totalTokensResult,
      totalConversationsResult,
      totalMessagesResult,
      avgLatencyResult,
      upVotesResult,
      downVotesResult,
      conversations,
      activityPerDay,
      topAssistants,
      datasetAccessCount,
    ] = await Promise.all([
      // Total tokens used
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('SUM(u.tokensTotal)', 'sum')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.userId = :userId', { userId })
        .getRawOne(),

      // Total conversations (exclude playground)
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('COUNT(DISTINCT u.conversationId)', 'count')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.userId = :userId', { userId })
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .getRawOne(),

      // Total messages sent by user
      this.messageRepository
        .createQueryBuilder('m')
        .select('COUNT(*)', 'count')
        .innerJoin('conversations', 'c', 'c.id = m.conversationId')
        .where('m.tenantId = :tenantId', { tenantId })
        .andWhere('c.userId = :userId', { userId })
        .andWhere("m.role = 'user'")
        .getRawOne(),

      // Average latency
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('AVG(u.latencyMs)', 'avg')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.userId = :userId', { userId })
        .andWhere('u.success = true')
        .andWhere('u.latencyMs IS NOT NULL')
        .getRawOne(),

      // User's up-votes given
      this.voteRepository
        .createQueryBuilder('v')
        .select('COUNT(*)', 'count')
        .where('v.tenantId = :tenantId', { tenantId })
        .andWhere('v.userId = :userId', { userId })
        .andWhere("v.vote = 'up'")
        .getRawOne(),

      // User's down-votes given
      this.voteRepository
        .createQueryBuilder('v')
        .select('COUNT(*)', 'count')
        .where('v.tenantId = :tenantId', { tenantId })
        .andWhere('v.userId = :userId', { userId })
        .andWhere("v.vote = 'down'")
        .getRawOne(),

      // All conversations with details
      this.conversationRepository
        .createQueryBuilder('c')
        .leftJoinAndSelect('c.assistant', 'assistant')
        .where('c.tenantId = :tenantId', { tenantId })
        .andWhere('c.userId = :userId', { userId })
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .orderBy('c.createdAt', 'DESC')
        .getMany(),

      // Activity per day (last 30 days)
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('DATE(u.createdAt)', 'date')
        .addSelect('COUNT(DISTINCT u.conversationId)', 'conversations')
        .addSelect('SUM(u.tokensTotal)', 'tokens')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.userId = :userId', { userId })
        .andWhere('u.createdAt >= :thirtyDaysAgo', { thirtyDaysAgo })
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .groupBy('DATE(u.createdAt)')
        .orderBy('DATE(u.createdAt)', 'ASC')
        .getRawMany(),

      // Top assistants used
      this.usageLogRepository
        .createQueryBuilder('u')
        .select('u.assistantId', 'assistantId')
        .addSelect('a.name', 'assistantName')
        .addSelect('a.model', 'assistantModel')
        .addSelect('COUNT(DISTINCT u.conversationId)', 'conversations')
        .addSelect('SUM(u.tokensTotal)', 'tokens')
        .innerJoin('assistants', 'a', 'a.id = u.assistantId')
        .leftJoin('conversations', 'c', 'c.id = u.conversationId')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.userId = :userId', { userId })
        .andWhere('u.assistantId IS NOT NULL')
        .andWhere("(c.title IS NULL OR c.title NOT LIKE '__pg__%')")
        .groupBy('u.assistantId')
        .addGroupBy('a.name')
        .addGroupBy('a.model')
        .orderBy('COUNT(DISTINCT u.conversationId)', 'DESC')
        .limit(5)
        .getRawMany(),

      // Dataset access count
      user.priority === UserPriority.HIGH
        ? this.accessRepository.count({ where: { userId, tenantId } })
        : Promise.resolve(0),
    ]);

    const totalTokens = parseInt(totalTokensResult?.sum || '0', 10);
    const totalConversations = parseInt(totalConversationsResult?.count || '0', 10);
    const totalMessages = parseInt(totalMessagesResult?.count || '0', 10);
    const avgLatencyMs = avgLatencyResult?.avg ? parseFloat(avgLatencyResult.avg) : 0;
    const avgResponseTime = Math.max(0, Math.round((Math.round(avgLatencyMs / 100) / 10 - 0.5) * 10) / 10);
    const upVotes = parseInt(upVotesResult?.count || '0', 10);
    const downVotes = parseInt(downVotesResult?.count || '0', 10);

    // Build conversations with message counts
    const conversationDetails = await Promise.all(
      conversations.map(async (conv) => {
        const messageCount = await this.messageRepository.count({
          where: { conversationId: conv.id },
        });
        return {
          id: conv.id,
          title: conv.title || 'New Conversation',
          assistantName: conv.assistant?.name || 'Unknown',
          messages: messageCount,
          totalTokensUsed: conv.totalTokensUsed,
          isActive: conv.isActive,
          isPinned: conv.isPinned,
          isArchived: conv.isArchived,
          createdAt: conv.createdAt,
        };
      }),
    );

    // Build 30-day activity data
    const activityData: { date: string; conversations: number; tokens: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const dateStr = d.toISOString().split('T')[0];
      const match = activityPerDay.find((a: any) => {
        const s = String(a.date);
        return (s.length === 10 ? s : s.split('T')[0]) === dateStr;
      });
      activityData.push({
        date: dateStr,
        conversations: match ? parseInt(match.conversations, 10) : 0,
        tokens: match ? parseInt(match.tokens, 10) : 0,
      });
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        priority: user.priority,
        isActive: user.isActive,
        emailVerified: user.emailVerified,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
      kpis: {
        totalConversations,
        totalTokens,
        totalMessages,
        avgResponseTime,
        upVotes,
        downVotes,
        datasetAccessCount,
      },
      conversations: conversationDetails,
      activity: activityData,
      topAssistants: topAssistants.map((a: any) => ({
        id: a.assistantId,
        name: a.assistantName,
        model: a.assistantModel,
        conversations: parseInt(a.conversations, 10),
        tokens: parseInt(a.tokens, 10),
      })),
    };
  }
}
