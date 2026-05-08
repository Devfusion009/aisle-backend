import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BaseRepository } from './base.repository';
import { Webhook } from '../entities/webhook.entity';

@Injectable()
export class WebhookRepo extends BaseRepository<Webhook> {
  constructor(
    @InjectRepository(Webhook) repo: Repository<Webhook>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find all active webhooks for a tenant */
  async findActive(tenantId: string): Promise<Webhook[]> {
    return this.repo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /** Find active webhooks subscribed to a specific event */
  async findByEvent(tenantId: string, event: string): Promise<Webhook[]> {
    return this.repo
      .createQueryBuilder('w')
      .where('w.tenantId = :tenantId', { tenantId })
      .andWhere('w.isActive = true')
      .andWhere('w.events @> :event', {
        event: JSON.stringify([event]),
      })
      .orderBy('w.createdAt', 'DESC')
      .getMany();
  }

  /** Toggle active/inactive state */
  async toggle(tenantId: string, id: string): Promise<Webhook> {
    const webhook = await this.findByIdOrFail(tenantId, id);
    webhook.isActive = !webhook.isActive;
    return this.repo.save(webhook);
  }

  /** Update lastFiredAt timestamp (fire-and-forget) */
  touchLastFired(tenantId: string, id: string): void {
    this.repo
      .update({ id, tenantId }, { lastFiredAt: new Date() })
      .catch(() => {});
  }
}
