import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BaseRepository } from './base.repository';
import { ApiKey } from '../entities/api-key.entity';

@Injectable()
export class ApiKeyRepo extends BaseRepository<ApiKey> {
  constructor(
    @InjectRepository(ApiKey) repo: Repository<ApiKey>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find a key by its SHA-256 hash (cross-tenant — used during auth) */
  async findByHash(keyHash: string): Promise<ApiKey | null> {
    return this.repo.findOne({ where: { keyHash } });
  }

  /** Find an active key by its hash or throw (for API auth) */
  async findActiveByHashOrFail(keyHash: string): Promise<ApiKey> {
    const key = await this.repo.findOne({
      where: { keyHash, isActive: true },
    });
    if (!key) throw new UnauthorizedException('Invalid or revoked API key');
    return key;
  }

  /** Find all active keys for a tenant */
  async findActive(tenantId: string): Promise<ApiKey[]> {
    return this.repo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /** Revoke (soft-disable) a key */
  async revoke(tenantId: string, id: string): Promise<ApiKey> {
    const key = await this.findByIdOrFail(tenantId, id);
    key.isActive = false;
    return this.repo.save(key);
  }

  /** Touch lastUsedAt timestamp (fire-and-forget) */
  touchLastUsed(id: string): void {
    this.repo.update(id, { lastUsedAt: new Date() }).catch(() => {});
  }

  /** Count active keys for a tenant */
  async countActive(tenantId: string): Promise<number> {
    return this.repo.count({ where: { tenantId, isActive: true } });
  }

  /** Find keys authorized for a specific assistant */
  async findByAuthorizedAssistant(
    tenantId: string,
    assistantId: string,
  ): Promise<ApiKey[]> {
    return this.repo
      .createQueryBuilder('k')
      .where('k.tenantId = :tenantId', { tenantId })
      .andWhere('k.isActive = true')
      .andWhere('k.authorizedAssistantIds @> :ids', {
        ids: JSON.stringify([assistantId]),
      })
      .orderBy('k.createdAt', 'DESC')
      .getMany();
  }
}
