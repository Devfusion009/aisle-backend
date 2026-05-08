import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Assistant } from '../../database/entities/assistant.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { Document } from '../../database/entities/document.entity';
import { Message } from '../../database/entities/message.entity';
import { MessageVote } from '../../database/entities/message-vote.entity';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Assistant,
      Conversation,
      UsageLog,
      Document,
      Message,
      MessageVote,
      UserDatasetAccess,
    ])
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
