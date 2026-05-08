import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { BaseRepository } from './base.repository';
import { UserDatasetAccess } from '../entities/user-dataset-access.entity';

@Injectable()
export class UserDatasetAccessRepo extends BaseRepository<UserDatasetAccess> {
  constructor(
    @InjectRepository(UserDatasetAccess) repo: Repository<UserDatasetAccess>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Get all dataset IDs a user has access to */
  async getDatasetIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const records = await this.repo.find({
      where: { tenantId, userId },
      select: ['datasetId'],
    });
    return records.map((r) => r.datasetId);
  }

  /** Check if a user has access to a specific dataset */
  async hasAccess(
    tenantId: string,
    userId: string,
    datasetId: string,
  ): Promise<boolean> {
    return (
      (await this.repo.count({
        where: { tenantId, userId, datasetId },
        take: 1,
      })) > 0
    );
  }

  /** Count datasets a user has access to */
  async countByUser(tenantId: string, userId: string): Promise<number> {
    return this.repo.count({ where: { tenantId, userId } });
  }

  /** Replace all dataset access for a user atomically */
  async setUserAccess(
    tenantId: string,
    userId: string,
    datasetIds: string[],
    grantedBy: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const run = async (mgr: EntityManager) => {
      const r = mgr.getRepository(UserDatasetAccess);
      await r.delete({ userId, tenantId });
      if (datasetIds.length > 0) {
        const entities = datasetIds.map((datasetId) =>
          r.create({ tenantId, userId, datasetId, grantedBy }),
        );
        await r.save(entities);
      }
    };

    if (manager) {
      await run(manager);
    } else {
      await this.ds.transaction(run);
    }
  }

  /** Remove all access for a user (when user is deleted or downgraded) */
  async removeAllForUser(
    tenantId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager.delete(UserDatasetAccess, { userId, tenantId });
    } else {
      await this.repo.delete({ userId, tenantId });
    }
  }

  /** Remove all access records for a dataset (when dataset is deleted) */
  async removeAllForDataset(
    tenantId: string,
    datasetId: string,
  ): Promise<number> {
    const result = await this.repo.delete({ tenantId, datasetId });
    return result.affected ?? 0;
  }

  /** Find all users with access to a specific dataset */
  async findUsersByDataset(
    tenantId: string,
    datasetId: string,
  ): Promise<UserDatasetAccess[]> {
    return this.repo.find({
      where: { tenantId, datasetId },
      order: { createdAt: 'DESC' },
    });
  }
}
