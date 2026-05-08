import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// ── Entities ─────────────────────────────────────────────────────────────
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import { Assistant } from '../entities/assistant.entity';
import { AssistantDataset } from '../entities/assistant-dataset.entity';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { MessageVote } from '../entities/message-vote.entity';
import { Document } from '../entities/document.entity';
import { DocumentChunk } from '../entities/document-chunk.entity';
import { UsageLog } from '../entities/usage-log.entity';
import { ApiKey } from '../entities/api-key.entity';
import { Webhook } from '../entities/webhook.entity';
import { AccessRequest } from '../entities/access-request.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { UserDatasetAccess } from '../entities/user-dataset-access.entity';

// ── Repositories ─────────────────────────────────────────────────────────
import { TenantRepo } from './tenant.repo';
import { UserRepo } from './user.repo';
import { AssistantRepo } from './assistant.repo';
import { ConversationRepo } from './conversation.repo';
import { MessageRepo } from './message.repo';
import { VoteRepo } from './vote.repo';
import { DocumentRepo } from './document.repo';
import { DocumentChunkRepo } from './document-chunk.repo';
import { UsageLogRepo } from './usage-log.repo';
import { ApiKeyRepo } from './api-key.repo';
import { WebhookRepo } from './webhook.repo';
import { AccessRequestRepo } from './access-request.repo';
import { SubscriptionPlanRepo } from './subscription-plan.repo';
import { UserDatasetAccessRepo } from './user-dataset-access.repo';

const ALL_ENTITIES = [
  Tenant,
  User,
  Assistant,
  AssistantDataset,
  Conversation,
  Message,
  MessageVote,
  Document,
  DocumentChunk,
  UsageLog,
  ApiKey,
  Webhook,
  AccessRequest,
  SubscriptionPlan,
  UserDatasetAccess,
];

const ALL_REPOS = [
  TenantRepo,
  UserRepo,
  AssistantRepo,
  ConversationRepo,
  MessageRepo,
  VoteRepo,
  DocumentRepo,
  DocumentChunkRepo,
  UsageLogRepo,
  ApiKeyRepo,
  WebhookRepo,
  AccessRequestRepo,
  SubscriptionPlanRepo,
  UserDatasetAccessRepo,
];

/**
 * Data Access Layer module.
 *
 * Marked @Global so every feature module can inject any repo
 * without needing to import DalModule explicitly.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature(ALL_ENTITIES)],
  providers: ALL_REPOS,
  exports: ALL_REPOS,
})
export class DalModule {}
