import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../../database/entities/api-key.entity';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiController } from './public-api.controller';
import { VectorSearchModule } from '../vector-search/vector-search.module';
import { LlmGatewayModule } from '../llm-gateway/llm-gateway.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey]),
    VectorSearchModule,
    LlmGatewayModule,
    ConversationsModule,
    WebhooksModule,
  ],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
