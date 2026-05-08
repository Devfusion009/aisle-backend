import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VectorSearchService } from './vector-search.service';
import { QdrantService } from './qdrant.service';
import { EmbeddingService } from '../ingestion/embedding.service';

/**
 * Vector Search Module
 * Handles semantic search using Qdrant vector database.
 *
 * EmbeddingService is registered here (and re-exported) so both the ingestion pipeline
 * and the query-time vector search share a single embedding provider configuration.
 */
@Module({
  imports: [ConfigModule],
  providers: [VectorSearchService, QdrantService, EmbeddingService],
  exports: [VectorSearchService, QdrantService, EmbeddingService],
})
export class VectorSearchModule {}
