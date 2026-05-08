import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssistantsController } from './assistants.controller';
import { DatasetsController } from './datasets.controller';
import { AssistantsService } from './assistants.service';
import { Assistant } from '../../database/entities/assistant.entity';
import { AssistantDataset } from '../../database/entities/assistant-dataset.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { Document } from '../../database/entities/document.entity';

/**
 * Assistant Management Module
 * Handles creation, configuration, and management of AI assistants.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Assistant, AssistantDataset, Tenant, Conversation, Document])],
  controllers: [AssistantsController, DatasetsController],
  providers: [AssistantsService],
  exports: [AssistantsService],
})
export class AssistantsModule {}
