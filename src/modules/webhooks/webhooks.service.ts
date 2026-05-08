import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Webhook } from '../../database/entities/webhook.entity';
import { TenantContext } from '../../common/interfaces/tenant-context.interface';
import { CreateWebhookDto, WebhookResponse } from './dto/webhook.dto';

@Injectable()
export class WebhooksService {
  constructor(@InjectRepository(Webhook) private readonly repo: Repository<Webhook>) {}

  async create(tenant: TenantContext, dto: CreateWebhookDto): Promise<WebhookResponse> {
    const w = this.repo.create({ tenantId: tenant.tenantId, ...dto });
    return this.toResponse(await this.repo.save(w));
  }

  async findAll(tenant: TenantContext): Promise<WebhookResponse[]> {
    const rows = await this.repo.find({ where: { tenantId: tenant.tenantId }, order: { createdAt: 'DESC' } });
    return rows.map(this.toResponse);
  }

  async toggle(tenant: TenantContext, id: string): Promise<WebhookResponse> {
    const w = await this.repo.findOne({ where: { id, tenantId: tenant.tenantId } });
    if (!w) throw new NotFoundException('Webhook not found');
    w.isActive = !w.isActive;
    return this.toResponse(await this.repo.save(w));
  }

  async remove(tenant: TenantContext, id: string): Promise<void> {
    const w = await this.repo.findOne({ where: { id, tenantId: tenant.tenantId } });
    if (!w) throw new NotFoundException('Webhook not found');
    await this.repo.remove(w);
  }

  private toResponse(w: Webhook): WebhookResponse {
    return {
      id: w.id,
      tenantId: w.tenantId,
      name: w.name,
      url: w.url,
      events: w.events ?? [],
      isActive: w.isActive,
      lastFiredAt: w.lastFiredAt ?? null,
      createdAt: w.createdAt,
    };
  }
}
