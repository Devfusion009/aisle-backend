import { Injectable, Logger } from '@nestjs/common';
import { QdrantService } from './qdrant.service';
import { EmbeddingService } from '../ingestion/embedding.service';

export interface SearchResult {
  documentId: string;
  chunkId: string;
  content: string;
  score: number;
}

@Injectable()
export class VectorSearchService {
  private readonly logger = new Logger(VectorSearchService.name);

  constructor(
    private readonly qdrantService: QdrantService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Search for relevant document chunks.
   * When datasetIds is provided, scopes search to those knowledge-base datasets.
   * When omitted/empty, searches all documents in the tenant.
   */
  async search(tenantId: string, datasetIds: string[] | undefined, query: string, topK: number = 5): Promise<SearchResult[]> {
    try {
      const queryEmbedding = await this.generateQueryEmbedding(query);
      const results = await this.qdrantService.search(queryEmbedding, tenantId, datasetIds, topK);
      return results.map((r) => ({
        documentId: r.payload.documentId,
        chunkId: r.id,
        content: r.payload.content,
        score: r.score,
      }));
    } catch (error) {
      this.logger.error('Vector search failed', error);
      throw error;
    }
  }

  async upsertVectors(points: { id: string; vector: number[]; payload: any }[]): Promise<void> {
    try {
      await this.qdrantService.upsert(points);
    } catch (error) {
      this.logger.error(`Failed to upsert ${points.length} vectors`, error);
      throw error;
    }
  }

  /** Search scoped to documents that belong to the given assistant IDs (for API key RAG) */
  async searchByAssistants(tenantId: string, assistantIds: string[], query: string, topK: number = 8): Promise<SearchResult[]> {
    try {
      const queryEmbedding = await this.generateQueryEmbedding(query);
      // Retrieve extra results then filter to those from authorized assistants
      const results = await this.qdrantService.search(queryEmbedding, tenantId, undefined, topK * 4);
      return results
        .filter((r) => assistantIds.includes(r.payload.assistantId))
        .slice(0, topK)
        .map((r) => ({
          documentId: r.payload.documentId,
          chunkId: r.id,
          content: r.payload.content,
          score: r.score,
        }));
    } catch (error) {
      this.logger.error('Vector search by assistants failed', error);
      throw error;
    }
  }

  async deleteDocumentVectors(documentId: string): Promise<void> {
    try {
      await this.qdrantService.deleteByDocumentId(documentId);
    } catch (error) {
      this.logger.error(`Failed to delete vectors for document ${documentId}`, error);
      throw error;
    }
  }

  private async generateQueryEmbedding(query: string): Promise<number[]> {
    try {
      return await this.embeddingService.generateEmbedding(query);
    } catch (error) {
      this.logger.error('Failed to generate query embedding', error);
      throw new Error(
        `Query embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
