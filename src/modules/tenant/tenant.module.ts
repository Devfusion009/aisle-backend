import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';
import { Tenant } from '../../database/entities/tenant.entity';
import { User } from '../../database/entities/user.entity';
import { Assistant } from '../../database/entities/assistant.entity';
import { Document } from '../../database/entities/document.entity';
import { UsageLog } from '../../database/entities/usage-log.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Tenant, User, Assistant, Document, UsageLog]),
        KnowledgeModule, // for StorageService
    ],
    controllers: [TenantController],
    providers: [TenantService],
    exports: [TenantService],
})
export class TenantModule { }
