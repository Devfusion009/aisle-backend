import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Not } from 'typeorm';
import { BaseRepository } from './base.repository';
import { User, UserPriority } from '../entities/user.entity';
import { UserRole } from '../../common/interfaces/tenant-context.interface';

@Injectable()
export class UserRepo extends BaseRepository<User> {
  constructor(
    @InjectRepository(User) repo: Repository<User>,
    ds: DataSource,
  ) {
    super(repo, ds);
  }

  /** Find user by email within a tenant (login, uniqueness) */
  async findByEmail(
    tenantId: string,
    email: string,
  ): Promise<User | null> {
    return this.repo.findOne({ where: { tenantId, email } });
  }

  /** Find user by email across all tenants (global uniqueness check) */
  async findByEmailGlobal(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email } });
  }

  /** Find all users with a specific role */
  async findByRole(tenantId: string, role: UserRole): Promise<User[]> {
    return this.repo.find({
      where: { tenantId, role },
      order: { createdAt: 'DESC' },
    });
  }

  /** Count non-owner users (for plan limit checks) */
  async countNonOwners(tenantId: string): Promise<number> {
    return this.repo.count({
      where: { tenantId, role: Not(UserRole.TENANT_OWNER) },
    });
  }

  /** Count active users */
  async countActive(tenantId: string): Promise<number> {
    return this.repo.count({
      where: { tenantId, isActive: true },
    });
  }

  /** Find all high-priority users */
  async findHighPriority(tenantId: string): Promise<User[]> {
    return this.repo.find({
      where: { tenantId, priority: UserPriority.HIGH },
      order: { name: 'ASC' },
    });
  }

  /** Update last login timestamp */
  async touchLastLogin(tenantId: string, id: string): Promise<void> {
    await this.repo.update(
      { id, tenantId },
      { lastLoginAt: new Date() } as any,
    );
  }

  /** Toggle active status */
  async setActive(
    tenantId: string,
    id: string,
    isActive: boolean,
  ): Promise<void> {
    await this.patch(tenantId, id, { isActive } as any);
  }

  /** Change role */
  async setRole(
    tenantId: string,
    id: string,
    role: UserRole,
  ): Promise<void> {
    await this.patch(tenantId, id, { role } as any);
  }

  /** Change priority */
  async setPriority(
    tenantId: string,
    id: string,
    priority: UserPriority,
  ): Promise<void> {
    await this.patch(tenantId, id, { priority } as any);
  }
}
