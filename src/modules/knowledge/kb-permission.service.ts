import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { UserDatasetAccess } from '../../database/entities/user-dataset-access.entity';

/**
 * KbPermissionService
 *
 * Encapsulates per-user, per-dataset access grants for knowledge-base resources.
 * Grants live in `user_dataset_access`. Read paths go through a small in-process
 * cache (30s TTL) — single-node only; swap to Redis if the deployment scales horizontally.
 */
@Injectable()
export class KbPermissionService {
  private readonly logger = new Logger(KbPermissionService.name);

  private readonly cache = new Map<string, { ids: Set<string>; exp: number }>();
  private readonly TTL_MS = 30_000;

  constructor(
    @InjectRepository(UserDatasetAccess)
    private readonly repo: Repository<UserDatasetAccess>,
  ) {}

  private cacheKey(userId: string, tenantId: string) {
    return `${tenantId}:${userId}`;
  }

  async listGrantedDatasetIds(userId: string, tenantId: string): Promise<Set<string>> {
    const key = this.cacheKey(userId, tenantId);
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.ids;

    const rows = await this.repo.find({
      where: { userId, tenantId },
      select: ['datasetId'],
    });
    const ids = new Set(rows.map((r) => r.datasetId));
    this.cache.set(key, { ids, exp: Date.now() + this.TTL_MS });
    return ids;
  }

  async userHasAccess(userId: string, tenantId: string, datasetId: string): Promise<boolean> {
    const ids = await this.listGrantedDatasetIds(userId, tenantId);
    return ids.has(datasetId);
  }

  invalidate(userId: string, tenantId: string): void {
    this.cache.delete(this.cacheKey(userId, tenantId));
  }

  async grant(userId: string, tenantId: string, datasetId: string, grantedBy: string): Promise<void> {
    await this.repo.upsert(
      { userId, tenantId, datasetId, grantedBy },
      ['userId', 'datasetId'],
    );
    this.invalidate(userId, tenantId);
  }

  async revoke(userId: string, tenantId: string, datasetId: string): Promise<void> {
    await this.repo.delete({ userId, tenantId, datasetId });
    this.invalidate(userId, tenantId);
  }

  async setUserDatasets(
    userId: string,
    tenantId: string,
    datasetIds: string[],
    grantedBy: string,
  ): Promise<void> {
    const current = await this.repo.find({ where: { userId, tenantId } });
    const want = new Set(datasetIds);
    const have = new Set(current.map((r) => r.datasetId));

    const toAdd = [...want].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));

    if (toRemove.length) {
      await this.repo.delete({ userId, tenantId, datasetId: In(toRemove) });
    }
    if (toAdd.length) {
      await this.repo.save(
        toAdd.map((datasetId) => ({ userId, tenantId, datasetId, grantedBy })),
      );
    }
    this.invalidate(userId, tenantId);
  }
}
