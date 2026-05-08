import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, DeepPartial, EntityManager } from 'typeorm';
import { Tenant } from '../entities/tenant.entity';

/**
 * Tenant Repository
 *
 * Special: Tenant is the root of multi-tenancy so most methods do NOT
 * take a tenantId parameter — the tenant IS the scoping boundary.
 */
@Injectable()
export class TenantRepo {
  constructor(
    @InjectRepository(Tenant) private readonly repo: Repository<Tenant>,
    private readonly ds: DataSource,
  ) {}

  get raw(): Repository<Tenant> {
    return this.repo;
  }

  async findById(id: string): Promise<Tenant | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<Tenant> {
    const tenant = await this.findById(id);
    if (!tenant) throw new Error('Tenant not found');
    return tenant;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.repo.findOne({ where: { slug } });
  }

  async findAll(): Promise<Tenant[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findActive(): Promise<Tenant[]> {
    return this.repo.find({ where: { isActive: true }, order: { name: 'ASC' } });
  }

  async create(data: DeepPartial<Tenant>): Promise<Tenant> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  async createWith(manager: EntityManager, data: DeepPartial<Tenant>): Promise<Tenant> {
    const r = manager.getRepository(Tenant);
    const entity = r.create(data);
    return r.save(entity);
  }

  async update(id: string, data: DeepPartial<Tenant>): Promise<Tenant> {
    const tenant = await this.findByIdOrFail(id);
    Object.assign(tenant, data);
    return this.repo.save(tenant);
  }

  async updatePlan(id: string, plan: string): Promise<void> {
    await this.repo.update(id, { plan });
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  async transaction<R>(fn: (manager: EntityManager) => Promise<R>): Promise<R> {
    return this.ds.transaction(fn);
  }
}
