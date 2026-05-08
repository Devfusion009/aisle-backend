import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, DeepPartial } from 'typeorm';
import { BaseRepository } from './base.repository';
import { DocumentChunk } from '../entities/document-chunk.entity';

@Injectable()
export class DocumentChunkRepo extends BaseRepository<DocumentChunk> {
  constructor(
    @InjectRepository(DocumentChunk) repo: Repository<DocumentChunk>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find all chunks for a document, ordered by index */
  async findByDocument(
    tenantId: string,
    documentId: string,
  ): Promise<DocumentChunk[]> {
    return this.repo.find({
      where: { tenantId, documentId },
      order: { chunkIndex: 'ASC' },
    });
  }

  /** Bulk insert chunks (used during ingestion) */
  async bulkInsertChunks(
    tenantId: string,
    chunks: DeepPartial<DocumentChunk>[],
    manager?: EntityManager,
  ): Promise<DocumentChunk[]> {
    if (chunks.length === 0) return [];

    const run = async (mgr: EntityManager) => {
      const r = mgr.getRepository(DocumentChunk);
      const entities = chunks.map((c) =>
        r.create({ tenantId, ...c }),
      );
      return r.save(entities);
    };

    if (manager) return run(manager);
    return this.ds.transaction(run);
  }

  /** Delete all chunks for a document */
  async deleteByDocument(
    tenantId: string,
    documentId: string,
  ): Promise<number> {
    const result = await this.repo.delete({ tenantId, documentId });
    return result.affected ?? 0;
  }

  /** Count chunks for a document */
  async countByDocument(
    tenantId: string,
    documentId: string,
  ): Promise<number> {
    return this.repo.count({ where: { tenantId, documentId } });
  }

  /** Get embedding IDs for a document (for vector store cleanup) */
  async getEmbeddingIds(
    tenantId: string,
    documentId: string,
  ): Promise<string[]> {
    const chunks = await this.repo.find({
      where: { tenantId, documentId },
      select: ['embeddingId'],
    });
    return chunks
      .map((c) => c.embeddingId)
      .filter((id): id is string => !!id);
  }
}
