import { Injectable, OnModuleInit, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SubscriptionPlan } from '../../database/entities/subscription-plan.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { PLAN_LIMITS } from '../../common/constants/plan-limits';

export interface UpdatePlanInput {
  displayName?: string | null;
  price?: number;
  currency?: string;
  billingPeriod?: string;
  maxUsers?: number;
  maxAssistants?: number;
  maxDatasets?: number;
  maxStorageBytes?: number;
  monthlyTokenLimit?: number;
  isActive?: boolean;
}

export interface CreatePlanInput extends UpdatePlanInput {
  name: string;
  code: string;
}

/**
 * Plans Service
 * Handles the synchronization of dynamic database plans with the in-memory cache.
 */
@Injectable()
export class PlansService implements OnModuleInit {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectRepository(SubscriptionPlan)
    private readonly planRepository: Repository<SubscriptionPlan>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.refreshPlansCache();
    const hasPlans = Object.keys(PLAN_LIMITS).length > 0;
    if (!hasPlans) {
      await this.seedDefaultPlans();
      await this.refreshPlansCache();
    }
  }

  /**
   * Fetches all active plans from the database and updates the global PLAN_LIMITS object
   * so synchronous consumers (like auth constraints) get the dynamic limits instantly.
   */
  async refreshPlansCache() {
    try {
      const activePlans = await this.planRepository.find({ where: { isActive: true } });

      // Clear current plan limits and replace with DB source of truth.
      // Note: we do NOT auto-seed defaults — the platform admin owns plan
      // configuration via /super-admin/plans. An empty cache is a valid
      // (pre-setup) state; getPlanLimits() handles it via SAFE_MINIMUM_LIMITS.
      for (const key of Object.keys(PLAN_LIMITS)) {
        delete PLAN_LIMITS[key];
      }

      for (const plan of activePlans) {
        PLAN_LIMITS[plan.code] = {
          maxUsers: plan.maxUsers,
          maxAssistants: plan.maxAssistants,
          maxDatasets: plan.maxDatasets,
          maxStorageBytes: Number(plan.maxStorageBytes),
          monthlyTokenLimit: Number(plan.monthlyTokenLimit),
        };
      }

      if (activePlans.length === 0) {
        this.logger.warn(
          'No active subscription plans configured. Visit /super-admin/plans to add at least one before onboarding tenants.',
        );
      } else {
        this.logger.log(`Refreshed ${activePlans.length} subscription plans into memory cache.`);
      }
    } catch (err) {
      this.logger.error('Failed to refresh pricing plans cache.', err);
    }
  }

  /**
   * Returns the cheapest active plan code, or null if no plans are configured.
   * Used by tenant-creation paths (signup, access-request approval, super-admin
   * "create tenant" form) so new orgs default to whatever the platform admin
   * has set as the entry-level tier.
   */
  async getDefaultPlanCodeForNewTenant(): Promise<string | null> {
    const cheapest = await this.planRepository.findOne({
      where: { isActive: true },
      order: { price: 'ASC', maxUsers: 'ASC' },
    });
    return cheapest?.code ?? null;
  }

  /**
   * Opt-in: creates Starter / Business / Enterprise tiers as a starting
   * point. Idempotent — does nothing if any plan already exists. Triggered
   * from the "Use suggested defaults" button on the empty Plans page.
   */
  async seedDefaultPlans(): Promise<SubscriptionPlan[]> {
    const existingCount = await this.planRepository.count();
    if (existingCount > 0) {
      this.logger.log(`Skipping default-plan seed — ${existingCount} plan(s) already configured.`);
      return this.planRepository.find({ order: { price: 'ASC' } });
    }

    this.logger.log('Seeding default subscription plans into the database...');

    // Defaults are *suggestions* — the platform admin is expected to edit
    // prices/limits to match their actual offering immediately after.
    const defaultPlans = [
      this.planRepository.create({
        name: 'Starter',
        displayName: 'Starter',
        code: 'starter',
        price: 0,
        currency: 'USD',
        billingPeriod: 'free',
        maxUsers: 5,
        maxAssistants: 3,
        maxDatasets: 5,
        maxStorageBytes: 1073741824, // 1 GB
        monthlyTokenLimit: 1000000,
      }),
      this.planRepository.create({
        name: 'Business',
        displayName: 'Business',
        code: 'business',
        price: 49,
        currency: 'USD',
        billingPeriod: 'monthly',
        maxUsers: 50,
        maxAssistants: 20,
        maxDatasets: 20,
        maxStorageBytes: 10737418240, // 10 GB
        monthlyTokenLimit: 10000000,
      }),
      this.planRepository.create({
        name: 'Enterprise',
        displayName: 'Enterprise',
        code: 'enterprise',
        price: 199,
        currency: 'USD',
        billingPeriod: 'monthly',
        maxUsers: 200,
        maxAssistants: 100,
        maxDatasets: 100,
        maxStorageBytes: 107374182400, // 100 GB
        monthlyTokenLimit: 100000000,
      })
    ];

    const saved = await this.planRepository.save(defaultPlans);
    await this.refreshPlansCache(); // Reload immediately after seeding
    return saved;
  }

  /**
   * Gets a list of all plans currently stored in the DB.
   */
  async getAllPlans(): Promise<SubscriptionPlan[]> {
    return this.planRepository.find({ order: { price: 'ASC', maxUsers: 'ASC' } });
  }

  /**
   * Plans visible to tenants (active only). Used by the billing page.
   */
  async getActivePlans(): Promise<SubscriptionPlan[]> {
    return this.planRepository.find({
      where: { isActive: true },
      order: { price: 'ASC', maxUsers: 'ASC' },
    });
  }

  async getByCode(code: string): Promise<SubscriptionPlan> {
    const plan = await this.planRepository.findOne({ where: { code } });
    if (!plan) throw new NotFoundException(`Plan "${code}" not found`);
    return plan;
  }

  /**
   * Update an existing plan by code. `code` itself is immutable to protect
   * tenant.plan foreign references. Refreshes the in-memory cache so all
   * limit checks pick up the new values immediately.
   */
  async updatePlan(code: string, dto: UpdatePlanInput): Promise<SubscriptionPlan> {
    const plan = await this.getByCode(code);

    if (dto.displayName !== undefined) plan.displayName = dto.displayName;
    if (dto.price !== undefined) plan.price = dto.price;
    if (dto.currency !== undefined) plan.currency = dto.currency;
    if (dto.billingPeriod !== undefined) plan.billingPeriod = dto.billingPeriod;
    if (dto.maxUsers !== undefined) plan.maxUsers = dto.maxUsers;
    if (dto.maxAssistants !== undefined) plan.maxAssistants = dto.maxAssistants;
    if (dto.maxDatasets !== undefined) plan.maxDatasets = dto.maxDatasets;
    if (dto.maxStorageBytes !== undefined) plan.maxStorageBytes = dto.maxStorageBytes;
    if (dto.monthlyTokenLimit !== undefined) plan.monthlyTokenLimit = dto.monthlyTokenLimit;
    if (dto.isActive !== undefined) {
      // Guard: don't deactivate a plan that tenants are currently on.
      if (!dto.isActive && plan.isActive) {
        const inUse = await this.tenantRepository.count({ where: { plan: code } });
        if (inUse > 0) {
          throw new ConflictException(
            `Cannot deactivate plan "${code}" — ${inUse} tenant(s) currently use it. Move them off first.`,
          );
        }
      }
      plan.isActive = dto.isActive;
    }

    const saved = await this.planRepository.save(plan);
    await this.refreshPlansCache();
    this.logger.log(`Plan "${code}" updated by admin; cache refreshed.`);
    return saved;
  }

  /**
   * Create a new plan tier. `code` must be unique and stable — it becomes the
   * value stored in tenant.plan when an org subscribes.
   */
  async createPlan(input: CreatePlanInput): Promise<SubscriptionPlan> {
    if (!input.code?.trim()) throw new BadRequestException('Plan code is required');
    if (!input.name?.trim()) throw new BadRequestException('Plan name is required');

    const existing = await this.planRepository.findOne({ where: { code: input.code } });
    if (existing) throw new ConflictException(`Plan code "${input.code}" already exists`);

    const plan = this.planRepository.create({
      name: input.name,
      displayName: input.displayName ?? input.name,
      code: input.code,
      price: input.price ?? 0,
      currency: input.currency ?? 'USD',
      billingPeriod: input.billingPeriod ?? 'monthly',
      maxUsers: input.maxUsers ?? 5,
      maxAssistants: input.maxAssistants ?? 3,
      maxDatasets: input.maxDatasets ?? 5,
      maxStorageBytes: input.maxStorageBytes ?? 1073741824,
      monthlyTokenLimit: input.monthlyTokenLimit ?? 1000000,
      isActive: input.isActive ?? true,
    });

    const saved = await this.planRepository.save(plan);
    await this.refreshPlansCache();
    this.logger.log(`Plan "${input.code}" created by admin; cache refreshed.`);
    return saved;
  }

  /**
   * One-shot configuration: replace the whole plan catalog with the supplied
   * array. Existing rows (matched by `code`) are updated; new codes are
   * inserted. Codes present in the DB but absent from `inputs` are
   * deactivated rather than deleted, so any tenant.plan FK keeps resolving.
   *
   * Wrapped in a transaction so a partial save is impossible — the form on
   * /super-admin/plans either commits in full or doesn't change anything.
   */
  async configurePlans(inputs: CreatePlanInput[]): Promise<SubscriptionPlan[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new BadRequestException('At least one plan must be configured.');
    }

    // Validate codes and check for in-payload duplicates before touching the DB.
    const seen = new Set<string>();
    for (const p of inputs) {
      if (!p.code?.trim()) throw new BadRequestException('Every tier must have a code.');
      if (!p.name?.trim()) throw new BadRequestException(`Tier "${p.code}" needs a name.`);
      if (!/^[a-z0-9_]+$/.test(p.code)) {
        throw new BadRequestException(`Tier code "${p.code}" must use only lowercase letters, numbers, and underscores.`);
      }
      if (seen.has(p.code)) throw new BadRequestException(`Duplicate tier code "${p.code}" in submission.`);
      seen.add(p.code);
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const planRepo = manager.getRepository(SubscriptionPlan);
      const tenantRepo = manager.getRepository(Tenant);
      const existing = await planRepo.find();
      const existingByCode = new Map(existing.map((p) => [p.code, p]));

      // Upsert each tier supplied in the form.
      for (const p of inputs) {
        const row = existingByCode.get(p.code);
        if (row) {
          row.name = p.name;
          row.displayName = p.displayName ?? p.name;
          row.price = p.price ?? 0;
          row.currency = p.currency ?? 'USD';
          row.billingPeriod = p.billingPeriod ?? 'monthly';
          row.maxUsers = p.maxUsers ?? row.maxUsers;
          row.maxAssistants = p.maxAssistants ?? row.maxAssistants;
          row.maxDatasets = p.maxDatasets ?? row.maxDatasets;
          row.maxStorageBytes = p.maxStorageBytes ?? row.maxStorageBytes;
          row.monthlyTokenLimit = p.monthlyTokenLimit ?? row.monthlyTokenLimit;
          row.isActive = p.isActive ?? true;
          await planRepo.save(row);
        } else {
          await planRepo.save(planRepo.create({
            name: p.name,
            displayName: p.displayName ?? p.name,
            code: p.code,
            price: p.price ?? 0,
            currency: p.currency ?? 'USD',
            billingPeriod: p.billingPeriod ?? 'monthly',
            maxUsers: p.maxUsers ?? 5,
            maxAssistants: p.maxAssistants ?? 3,
            maxDatasets: p.maxDatasets ?? 5,
            maxStorageBytes: p.maxStorageBytes ?? 1073741824,
            monthlyTokenLimit: p.monthlyTokenLimit ?? 1000000,
            isActive: p.isActive ?? true,
          }));
        }
      }

      // Tiers in DB but not in the submission: deactivate (don't delete) so
      // any tenant whose `plan` still references the code keeps resolving.
      const submittedCodes = new Set(inputs.map((p) => p.code));
      for (const row of existing) {
        if (submittedCodes.has(row.code)) continue;
        const inUse = await tenantRepo.count({ where: { plan: row.code } });
        if (inUse > 0 && row.isActive) {
          throw new ConflictException(
            `Cannot remove plan "${row.code}" — ${inUse} tenant(s) currently use it. ` +
            `Either keep the tier in the configuration or move those tenants to another plan first.`,
          );
        }
        if (row.isActive) {
          row.isActive = false;
          await planRepo.save(row);
        }
      }

      return planRepo.find({ order: { price: 'ASC', maxUsers: 'ASC' } });
    });

    await this.refreshPlansCache();
    this.logger.log(`Plan configuration replaced — ${inputs.length} tier(s) saved; cache refreshed.`);
    return result;
  }
}
