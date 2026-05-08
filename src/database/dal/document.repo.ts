import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BaseRepository } from './base.repository';
import { Document, DocumentStatus } from '../entities/document.entity';

@Injectable()
export class DocumentRepo extends BaseRepository<Document> {
  constructor(
    @InjectRepository(Document) repo: Repository<Document>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find all documents for a dataset/assistant */
  async findByAssistant(
    tenantId: string,
    assistantId: string,
  ): Promise<Document[]> {
    return this.repo.find({
      where: { tenantId, assistantId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Check for a duplicate by filename + assistant */
  async findDuplicate(
    tenantId: string,
    assistantId: string,
    filename: string,
  ): Promise<Document | null> {
    return this.repo.findOne({
      where: { tenantId, assistantId, filename },
    });
  }

  /** Update processing status (and optional error) */
  async setStatus(
    tenantId: string,
    id: string,
    status: DocumentStatus,
    errorMessage?: string,
  ): Promise<void> {
    const update: Partial<Document> = { status };
    if (errorMessage !== undefined) update.errorMessage = errorMessage;
    if (status === DocumentStatus.FAILED && !errorMessage) {
      update.errorMessage = 'Unknown error';
    }
    await this.repo.update({ id, tenantId }, update);
  }

  /** Update chunk/character counts after ingestion */
  async setIngestionStats(
    tenantId: string,
    id: string,
    chunkCount: number,
    characterCount: number,
  ): Promise<void> {
    await this.repo.update({ id, tenantId }, { chunkCount, characterCount });
  }

  /** Count documents per tenant (for plan limit checks) */
  async countByTenant(tenantId: string): Promise<number> {
    return this.repo.count({ where: { tenantId } });
  }

  /** Count documents per assistant */
  async countByAssistant(
    tenantId: string,
    assistantId: string,
  ): Promise<number> {
    return this.repo.count({ where: { tenantId, assistantId } });
  }

  /** Sum total file size in bytes for a tenant (storage billing) */
  async totalStorageBytes(tenantId: string): Promise<number> {
    const result = await this.repo
      .createQueryBuilder('d')
      .select('COALESCE(SUM(d.fileSize), 0)', 'total')
      .where('d.tenantId = :tenantId', { tenantId })
      .getRawOne();
    return parseInt(result?.total ?? '0', 10);
  }

  /** Find documents with specific statuses */
  async findByStatus(
    tenantId: string,
    status: DocumentStatus,
  ): Promise<Document[]> {
    return this.repo.find({
      where: { tenantId, status },
      order: { createdAt: 'ASC' },
    });
  }
}
