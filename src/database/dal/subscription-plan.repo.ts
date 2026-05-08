import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, DeepPartial } from 'typeorm';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';

/**
 * SubscriptionPlan repository.
 *
 * NOTE: This does NOT extend BaseRepository because plans are global
 * (not tenant-scoped). Provides its own focused CRUD.
 */
@Injectable()
export class SubscriptionPlanRepo {
  constructor(
    @InjectRepository(SubscriptionPlan)
    private readonly repo: Repository<SubscriptionPlan>,
    private readonly ds: DataSource,
  ) {}

  /** Expose raw repo */
  get raw(): Repository<SubscriptionPlan> {
    return this.repo;
  }

  // ── Read ─────────────────────────────────────────────────────────────

  async findById(id: string): Promise<SubscriptionPlan | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByIdOrFail(id: string): Promise<SubscriptionPlan> {
    const plan = await this.repo.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  /** Find a plan by its unique code (e.g. 'starter', 'business') */
  async findByCode(code: string): Promise<SubscriptionPlan | null> {
    return this.repo.findOne({ where: { code } });
  }

  async findByCodeOrFail(code: string): Promise<SubscriptionPlan> {
    const plan = await this.repo.findOne({ where: { code } });
    if (!plan) throw new NotFoundException(`Plan "${code}" not found`);
    return plan;
  }

  /** All plans, ordered by maxUsers ascending */
  async findAll(): Promise<SubscriptionPlan[]> {
    return this.repo.find({ order: { maxUsers: 'ASC' } });
  }

  /** Only active plans */
  async findActive(): Promise<SubscriptionPlan[]> {
    return this.repo.find({
      where: { isActive: true },
      order: { maxUsers: 'ASC' },
    });
  }

  // ── Write ────────────────────────────────────────────────────────────

  /** Create a new plan */
  async create(data: DeepPartial<SubscriptionPlan>): Promise<SubscriptionPlan> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  /** Update an existing plan */
  async update(
    id: string,
    data: DeepPartial<SubscriptionPlan>,
  ): Promise<SubscriptionPlan> {
    const plan = await this.findByIdOrFail(id);
    Object.assign(plan, data);
    return this.repo.save(plan);
  }

  /** Toggle active flag */
  async toggleActive(id: string): Promise<SubscriptionPlan> {
    const plan = await this.findByIdOrFail(id);
    plan.isActive = !plan.isActive;
    return this.repo.save(plan);
  }

  /** Bulk save (used for seeding) */
  async bulkSave(
    plans: DeepPartial<SubscriptionPlan>[],
  ): Promise<SubscriptionPlan[]> {
    const entities = plans.map((p) => this.repo.create(p));
    return this.repo.save(entities);
  }

  /** Count active plans */
  async countActive(): Promise<number> {
    return this.repo.count({ where: { isActive: true } });
  }
}
