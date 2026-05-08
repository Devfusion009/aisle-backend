import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Document, DocumentStatus } from '../../database/entities/document.entity';
import { DocumentChunk } from '../../database/entities/document-chunk.entity';
import { StorageService } from '../knowledge/storage.service';
import { ExtractionService } from './extraction.service';
import { ChunkingService, TextChunk } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { VectorSearchService } from '../vector-search/vector-search.service';

/**
 * Ingestion Service
 * Orchestrates the complete document ingestion pipeline.
 * 
 * Pipeline:
 * 1. Download document from S3
 * 2. Extract text based on file type
 * 3. Split into chunks
 * 4. Generate embeddings
 * 5. Store in vector database
 * 6. Update document status
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    @Inject(forwardRef(() => StorageService))
    private readonly storageService: StorageService,
    private readonly extractionService: ExtractionService,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Queue a document for processing
   * In production, this would use Bull queue for async processing
   */
  async queueDocument(documentId: string): Promise<void> {
    // For simplicity, process immediately (in production, use Bull queue)
    setImmediate(() => {
      this.processDocument(documentId).catch((err) => {
        this.logger.error(`Failed to process document ${documentId}`, err);
      });
    });
  }

  /**
   * Process a document through the ingestion pipeline
   */
  async processDocument(documentId: string): Promise<void> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });

    if (!document) {
      this.logger.error(`Document ${documentId} not found`);
      return;
    }

    try {
      // Update status to processing
      await this.updateDocumentStatus(documentId, DocumentStatus.PROCESSING);

      // Step 1: Download from S3
      this.logger.log(`Downloading document ${documentId} from S3`);
      const buffer = await this.storageService.downloadFile(document.s3Key);

      // Step 2: Extract text
      this.logger.log(`Extracting text from document ${documentId}`);
      const text = await this.extractionService.extractText(buffer, document.mimeType);

      if (!text || text.trim().length === 0) {
        throw new Error('No text content extracted from document. If this is a PDF, it may be a scanned image-only PDF lacking an embedded text layer. Optical Character Recognition (OCR) is required for scanned documents.');
      }

      // Step 3: Chunk text
      this.logger.log(`Chunking document ${documentId}`);
      const chunks = this.chunkingService.chunkText(text);

      if (chunks.length === 0) {
        throw new Error('No chunks generated from document');
      }

      // Step 4: Generate embeddings (batch processing)
      this.logger.log(`Generating embeddings for ${chunks.length} chunks`);
      const embeddings = await this.generateEmbeddingsInBatches(chunks.map((c) => c.content));

      // Step 5: Store chunks and embeddings
      this.logger.log(`Storing chunks and embeddings for document ${documentId}`);
      await this.storeChunksAndEmbeddings(document, chunks, embeddings);

      // Step 6: Update document status
      await this.documentRepository.update(documentId, {
        status: DocumentStatus.COMPLETED,
        chunkCount: chunks.length,
        characterCount: text.length,
      });

      this.logger.log(`Successfully processed document ${documentId}`);
    } catch (error) {
      this.logger.error(`Failed to process document ${documentId}`, error);
      // Delete the file from S3 to save space, but KEEP the DB record so the user can see the error
      try {
        await this.storageService.deleteFile(document.s3Key);
      } catch (cleanupErr) {
        this.logger.error(`Failed to clean up S3 file for failed document ${documentId}`, cleanupErr);
      }
      
      // Update record to FAILED with the exact error message
      await this.documentRepository.update(documentId, {
        status: DocumentStatus.FAILED,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      this.logger.log(`Marked document ${documentId} as FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate embeddings in batches to avoid rate limits
   */
  private async generateEmbeddingsInBatches(texts: string[], batchSize: number = 20): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      try {
        const embeddings = await this.embeddingService.generateEmbeddings(batch);
        allEmbeddings.push(...embeddings);
      } catch (error) {
        this.logger.error(
          `Failed to generate embeddings for batch ${Math.floor(i / batchSize) + 1} (items ${i}-${i + batch.length - 1})`,
          error,
        );
        throw new Error(
          `Embedding generation failed at batch ${Math.floor(i / batchSize) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Small delay between batches to avoid rate limits
      if (i + batchSize < texts.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return allEmbeddings;
  }

  /**
   * Store chunks in database and vectors in Qdrant atomically.
   * Uses a DB transaction: if Qdrant upsert fails, the transaction rolls back
   * automatically — no manual chunk cleanup needed.
   */
  private async storeChunksAndEmbeddings(
    document: Document,
    chunks: TextChunk[],
    embeddings: number[][],
  ): Promise<void> {
    const chunkEntities: DocumentChunk[] = [];
    const vectorPoints: { id: string; vector: number[]; payload: any }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embeddingId = uuidv4();

      // Create chunk entity
      const chunkEntity = this.chunkRepository.create({
        tenantId: document.tenantId,
        documentId: document.id,
        content: chunk.content,
        chunkIndex: chunk.index,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        tokenCount: chunk.tokenCount,
        embeddingId,
      });
      chunkEntities.push(chunkEntity);

      // Prepare vector point for Qdrant
      vectorPoints.push({
        id: embeddingId,
        vector: embeddings[i],
        payload: {
          tenantId: document.tenantId,
          assistantId: document.assistantId,
          documentId: document.id,
          chunkIndex: chunk.index,
          content: chunk.content,
        },
      });
    }

    // Use a transaction: save chunks + upsert vectors.
    // If Qdrant fails, the thrown error rolls back the chunk inserts automatically.
    await this.dataSource.transaction(async (manager) => {
      await manager.save(chunkEntities);

      try {
        await this.vectorSearchService.upsertVectors(vectorPoints);
      } catch (error) {
        this.logger.error(
          `Failed to store vectors in Qdrant for document ${document.id}. Transaction will roll back ${chunkEntities.length} DB chunks.`,
          error,
        );
        throw error; // Propagate to roll back the transaction
      }
    });
  }

  /**
   * Update document status
   */
  private async updateDocumentStatus(documentId: string, status: DocumentStatus): Promise<void> {
    try {
      await this.documentRepository.update(documentId, { status });
    } catch (error) {
      this.logger.error(`Failed to update document ${documentId} status to ${status}`, error);
      throw error;
    }
  }
}
