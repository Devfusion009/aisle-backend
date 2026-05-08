import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { IngestionService } from './ingestion.service';
import { ExtractionService } from './extraction.service';
import { ChunkingService } from './chunking.service';
import { Document } from '../../database/entities/document.entity';
import { DocumentChunk } from '../../database/entities/document-chunk.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { VectorSearchModule } from '../vector-search/vector-search.module';

/**
 * Ingestion Pipeline Module
 * Handles async document processing: extraction, chunking, embedding.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentChunk]),
    ConfigModule,
    forwardRef(() => KnowledgeModule),
    VectorSearchModule,
  ],
  providers: [IngestionService, ExtractionService, ChunkingService],
  exports: [IngestionService],
})
export class IngestionModule {}
