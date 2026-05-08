import { Injectable, ConflictException, NotFoundException, BadRequestException, ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { hashPassword } from '../../common/utils/password.util';

import { User } from '../../database/entities/user.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { CreateTenantDto, CreateUserBySuperAdminDto, UpdateTenantDto } from './dto/super-admin.dto';
import { UserRole } from '../../common/interfaces/tenant-context.interface';
import { getPlanLimits } from '../../common/constants/plan-limits';
import { PlansService } from '../plans/plans.service';

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
    private readonly plansService: PlansService,
  ) { }

  async getAllAssistants(): Promise<any[]> {
    return this.dataSource.query('SELECT * FROM "assistants" ORDER BY "createdAt" DESC');
  }

  async getTokenUsage(days: number): Promise<{ date: string; tokens: number }[]> {
    const rows = await this.dataSource.query(
      `SELECT DATE("createdAt") AS date, SUM("tokensTotal")::int AS tokens
       FROM usage_logs
       WHERE "createdAt" >= NOW() - ($1 || ' days')::interval
       GROUP BY DATE("createdAt")
       ORDER BY date ASC`,
      [days],
    );
    return rows.map((r: any) => ({ date: String(r.date).slice(0, 10), tokens: Number(r.tokens) }));
  }

  async getAllDocuments(): Promise<any[]> {
    return this.dataSource.query('SELECT * FROM "documents" ORDER BY "createdAt" DESC');
  }

  async createTenant(dto: CreateTenantDto): Promise<Tenant> {
    const existing = await this.tenantRepository.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException('Tenant with this slug already exists');
    }

    // Resolve plan: caller-supplied code (validated) or cheapest active plan.
    const planCode = await this.resolveTenantPlanCode(dto.plan);

    try {
      const tenant = this.tenantRepository.create({
        name: dto.name,
        slug: dto.slug,
        plan: planCode,
        settings: {},
        isActive: true,
      });
      return await this.tenantRepository.save(tenant);
    } catch (error) {
      this.logger.error(`Failed to create tenant: ${dto.name}`, error);
      throw new InternalServerErrorException('Failed to create tenant');
    }
  }

  /**
   * Pick the plan code a new tenant should land on. Validates the requested
   * code if one was provided; otherwise falls back to the cheapest active
   * plan. Throws a clear error when nothing is available.
   */
  private async resolveTenantPlanCode(requested?: string | null): Promise<string> {
    if (requested) {
      try {
        await this.plansService.getByCode(requested);
        return requested;
      } catch {
        throw new BadRequestException(`Plan "${requested}" does not exist. Available plans can be managed at /super-admin/plans.`);
      }
    }
    const fallback = await this.plansService.getDefaultPlanCodeForNewTenant();
    if (!fallback) {
      throw new BadRequestException(
        'No subscription plans configured. Please add at least one plan at /super-admin/plans before creating a tenant.',
      );
    }
    return fallback;
  }

  async updateTenant(
    id: string,
    dto: UpdateTenantDto,
    actor?: { userId: string; email: string },
  ): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (dto.slug && dto.slug !== tenant.slug) {
      const conflict = await this.tenantRepository.findOne({ where: { slug: dto.slug } });
      if (conflict && conflict.id !== id) {
        throw new ConflictException('Tenant with this slug already exists');
      }
      tenant.slug = dto.slug;
    }
    if (dto.name !== undefined) tenant.name = dto.name;

    // Plan change audit log: emit a structured event whenever a tenant's
    // subscription plan is mutated. This is the only path that may change
    // tenant.plan (the self-service /tenant/plan route was removed because
    // it had no payment verification). Logged fields are designed to be
    // grep-friendly for ops/finance reconciliation.
    const previousPlan = tenant.plan;
    if (dto.plan !== undefined && dto.plan !== previousPlan) {
      tenant.plan = dto.plan;
      this.logger.log(
        `event=plan_change tenantId=${id} tenantName="${tenant.name}" ` +
        `previousPlan=${previousPlan} newPlan=${dto.plan} ` +
        `actorUserId=${actor?.userId ?? 'unknown'} actorEmail=${actor?.email ?? 'unknown'}`,
      );
    } else if (dto.plan !== undefined) {
      tenant.plan = dto.plan;
    }

    try {
      return await this.tenantRepository.save(tenant);
    } catch (error) {
      this.logger.error(`Failed to update tenant: ${id}`, error);
      throw new InternalServerErrorException('Failed to update tenant');
    }
  }

  async deleteTenant(id: string): Promise<void> {
    const tenant = await this.tenantRepository.findOne({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    try {
      // Child tables (users, assistants, documents, conversations, ...)
      // all declare `onDelete: 'CASCADE'` on their tenantId FK, so this will
      // atomically purge everything owned by the tenant.
      await this.tenantRepository.remove(tenant);
    } catch (error) {
      this.logger.error(`Failed to delete tenant: ${id}`, error);
      throw new InternalServerErrorException('Failed to delete tenant');
    }
  }

  async getAllTenants(): Promise<any[]> {
    const tenants = await this.tenantRepository.find({ order: { createdAt: 'DESC' } });
    const usageQuery = await this.dataSource.query(
      `SELECT "tenantId", SUM("tokensTotal")::int as total_tokens 
       FROM usage_logs GROUP BY "tenantId"`
    );
    const usageMap = Object.fromEntries(
      usageQuery.map((u: any) => [u.tenantId, Number(u.total_tokens)])
    );

    return tenants.map(t => ({
      ...t,
      tokensConsumed: usageMap[t.id] || 0
    }));
  }

  async createUser(dto: CreateUserBySuperAdminDto): Promise<User> {
    // Check if user already exists (before transaction)
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists. Each email can only be associated with one account.');
    }

    // Use a transaction so tenant + user creation is atomic
    return this.dataSource.transaction(async (manager) => {
      let tenantId = dto.tenantId;

      if (!tenantId) {
        if (dto.newTenantName && dto.newTenantSlug) {
          const existingTenant = await manager.findOne(Tenant, { where: { slug: dto.newTenantSlug } });
          if (existingTenant) {
            throw new ConflictException('Tenant with this slug already exists');
          }

          const planCode = await this.resolveTenantPlanCode(dto.newTenantPlan);
          const newTenant = manager.create(Tenant, {
            name: dto.newTenantName,
            slug: dto.newTenantSlug,
            plan: planCode,
            settings: {},
            isActive: true,
          });
          const saved = await manager.save(newTenant);
          tenantId = saved.id;
        } else {
          throw new BadRequestException('Provide either tenantId or newTenantName/Slug');
        }
      } else {
        const existingTenant = await manager.findOne(Tenant, { where: { id: tenantId } });
        if (!existingTenant) {
          throw new NotFoundException('Tenant not found');
        }
      }

      // Enforce user limit for the target tenant
      const targetTenant = await manager.findOne(Tenant, { where: { id: tenantId } });
      if (targetTenant) {
        const maxUsers = getPlanLimits(targetTenant.plan).maxUsers;
        const currentUsers = await manager.count(User, { where: { tenantId } });
        if (currentUsers >= maxUsers) {
          throw new ForbiddenException(`This organization's plan (${targetTenant.plan}) limits to ${maxUsers} user(s). Please upgrade the plan.`);
        }
      }

      const passwordHash = await hashPassword(dto.password);

      const user = manager.create(User, {
        tenantId,
        email: dto.email,
        name: dto.name,
        passwordHash,
        role: dto.role || UserRole.TENANT_ADMIN,
        isActive: true,
      });

      return manager.save(user);
    });
  }

  async getAllUsers(): Promise<User[]> {
    return this.userRepository.find({
      relations: ['tenant'],
      order: { createdAt: 'DESC' },
    });
  }

  async updateUserRole(userId: string, targetRole: UserRole): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.role = targetRole;
    return this.userRepository.save(user);
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.userRepository.remove(user);
  }
}
