import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ChatService } from './chat.service';
import { SessionService } from './session.service';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message } from '../../database/entities/message.entity';
import { MessageVote } from '../../database/entities/message-vote.entity';
import { AssistantsModule } from '../assistants/assistants.module';
import { VectorSearchModule } from '../vector-search/vector-search.module';
import { LlmGatewayModule } from '../llm-gateway/llm-gateway.module';
import { UsageModule } from '../usage/usage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { QuotasModule } from '../quotas/quotas.module';

/**
 * Conversations Module
 * Handles chat conversations, message history, and session state.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, MessageVote]),
    AssistantsModule,
    VectorSearchModule,
    LlmGatewayModule,
    UsageModule,
    WebhooksModule,
    QuotasModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService, ChatService, SessionService],
  exports: [ConversationsService, ChatService, SessionService],
})
export class ConversationsModule {}
