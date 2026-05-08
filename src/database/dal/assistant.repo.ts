import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { BaseRepository } from './base.repository';
import { Assistant } from '../entities/assistant.entity';
import { AssistantDataset } from '../entities/assistant-dataset.entity';

@Injectable()
export class AssistantRepo extends BaseRepository<Assistant> {
  constructor(
    @InjectRepository(Assistant) repo: Repository<Assistant>,
    @InjectRepository(AssistantDataset)
    private readonly linkRepo: Repository<AssistantDataset>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find only chat assistants (not datasets) */
  async findAssistants(tenantId: string): Promise<Assistant[]> {
    return this.repo.find({
      where: { tenantId, isDataset: false },
      order: { createdAt: 'DESC' },
    });
  }

  /** Find active chat assistants */
  async findActiveAssistants(tenantId: string): Promise<Assistant[]> {
    return this.repo.find({
      where: { tenantId, isDataset: false, isActive: true },
      order: { name: 'ASC' },
    });
  }

  /** Find only dataset folders */
  async findDatasets(tenantId: string): Promise<Assistant[]> {
    return this.repo.find({
      where: { tenantId, isDataset: true },
      order: { name: 'ASC' },
    });
  }

  /** Count chat assistants (for plan limits) */
  async countAssistants(tenantId: string): Promise<number> {
    return this.repo.count({ where: { tenantId, isDataset: false } });
  }

  /** Count datasets (for plan limits) */
  async countDatasets(tenantId: string): Promise<number> {
    return this.repo.count({ where: { tenantId, isDataset: true } });
  }

  // ── Dataset linking ────────────────────────────────────────────────

  /** Get dataset IDs linked to an assistant */
  async getLinkedDatasetIds(
    tenantId: string,
    assistantId: string,
  ): Promise<string[]> {
    const links = await this.linkRepo.find({
      where: { tenantId, assistantId },
      select: ['datasetId'],
    });
    return links.map((l) => l.datasetId);
  }

  /** Get full dataset entities linked to an assistant */
  async getLinkedDatasets(
    tenantId: string,
    assistantId: string,
  ): Promise<Assistant[]> {
    const ids = await this.getLinkedDatasetIds(tenantId, assistantId);
    if (ids.length === 0) return [];
    return this.repo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids })
      .andWhere('a.tenantId = :tenantId', { tenantId })
      .getMany();
  }

  /** Replace all dataset links for an assistant atomically */
  async setLinkedDatasets(
    tenantId: string,
    assistantId: string,
    datasetIds: string[],
    manager?: EntityManager,
  ): Promise<void> {
    const run = async (mgr: EntityManager) => {
      const linkR = mgr.getRepository(AssistantDataset);
      await linkR.delete({ assistantId, tenantId });
      if (datasetIds.length > 0) {
        const links = datasetIds.map((datasetId) =>
          linkR.create({ assistantId, datasetId, tenantId }),
        );
        await linkR.save(links);
      }
    };

    if (manager) {
      await run(manager);
    } else {
      await this.ds.transaction(run);
    }
  }

  /** Find assistants with conversation counts (common dashboard query) */
  async findWithConversationCounts(
    tenantId: string,
  ): Promise<(Assistant & { conversationCount: number })[]> {
    const rows = await this.repo
      .createQueryBuilder('a')
      .leftJoin('conversations', 'c', 'c.assistantId = a.id')
      .select('a.*')
      .addSelect('COUNT(DISTINCT c.id)', 'conversationCount')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere('a.isDataset = false')
      .groupBy('a.id')
      .orderBy('a.createdAt', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      ...r,
      conversationCount: parseInt(r.conversationCount, 10) || 0,
    }));
  }
}
