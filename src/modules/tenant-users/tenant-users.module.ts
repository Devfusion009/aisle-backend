import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantUsersController } from './tenant-users.controller';
import { TenantUsersService } from './tenant-users.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { User } from '../../database/entities/user.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';
import { Conversation } from '../../database/entities/conversation.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { Message } from '../../database/entities/message.entity';
import { MessageVote } from '../../database/entities/message-vote.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant, UserDatasetAccess, Conversation, UsageLog, Message, MessageVote]),
    KnowledgeModule,
  ],
  controllers: [TenantUsersController],
  providers: [TenantUsersService],
  exports: [TenantUsersService],
})
export class TenantUsersModule {}
