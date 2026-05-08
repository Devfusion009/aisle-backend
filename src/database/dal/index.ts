// ── Base ──────────────────────────────────────────────────────────────────
export {
  BaseRepository,
  PaginationOpts,
  PaginatedResult,
  FindOpts,
  DateRange,
  PLAYGROUND_PREFIX,
} from './base.repository';

// ── Repositories ─────────────────────────────────────────────────────────
export { TenantRepo } from './tenant.repo';
export { UserRepo } from './user.repo';
export { AssistantRepo } from './assistant.repo';
export { ConversationRepo } from './conversation.repo';
export { MessageRepo } from './message.repo';
export { VoteRepo, VoteAggregation } from './vote.repo';
export { DocumentRepo } from './document.repo';
export { DocumentChunkRepo } from './document-chunk.repo';
export {
  UsageLogRepo,
  TokenAggregation,
  DailyTrendRow,
  HourlyRow,
  AssistantUsageRow,
} from './usage-log.repo';
export { ApiKeyRepo } from './api-key.repo';
export { WebhookRepo } from './webhook.repo';
export { AccessRequestRepo } from './access-request.repo';
export { SubscriptionPlanRepo } from './subscription-plan.repo';
export { UserDatasetAccessRepo } from './user-dataset-access.repo';

// ── Module ───────────────────────────────────────────────────────────────
export { DalModule } from './dal.module';
