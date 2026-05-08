import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { StorageService } from './storage.service';
import { KbPermissionService } from './kb-permission.service';
import { Document } from '../../database/entities/document.entity';
import { DocumentChunk } from '../../database/entities/document-chunk.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';
import { Assistant } from '../../database/entities/assistant.entity';
import { IngestionModule } from '../ingestion/ingestion.module';
import { VectorSearchModule } from '../vector-search/vector-search.module';
import { QuotasModule } from '../quotas/quotas.module';

/**
 * Knowledge Base Module
 * Handles document upload, storage, and metadata management,
 * plus the per-user dataset access grants consumed by KbPermissionGuard.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentChunk, Tenant, UserDatasetAccess, Assistant]),
    ConfigModule,
    forwardRef(() => IngestionModule),
    VectorSearchModule,
    QuotasModule,
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, StorageService, KbPermissionService],
  exports: [KnowledgeService, StorageService, KbPermissionService],
})
export class KnowledgeModule {}
