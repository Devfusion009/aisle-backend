import { Injectable, Logger, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { hashPassword, generateSecurePassword } from '../../common/utils/password.util';
import { v4 as uuidv4 } from 'uuid';

import { AccessRequest, AccessRequestStatus } from '../../database/entities/access-request.entity';
import { User } from '../../database/entities/user.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { UserRole, TenantContext } from '../../common/interfaces/tenant-context.interface';
import { CreateAccessRequestDto, ApproveAccessRequestDto, AccessRequestResponse } from './dto/access-request.dto';
import { PlansService } from '../plans/plans.service';

@Injectable()
export class AccessRequestsService {
  private readonly logger = new Logger(AccessRequestsService.name);

  constructor(
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepo: Repository<AccessRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly dataSource: DataSource,
    private readonly plansService: PlansService,
  ) { }

  /**
   * Submit a new access request (public, no auth).
   *
   * The public flow references tenants by `slug`, not by UUID — UUIDs are
   * never exposed to unauthenticated callers, which would let attackers
   * enumerate the tenant table.
   */
  async create(dto: CreateAccessRequestDto): Promise<AccessRequestResponse> {
    // Resolve tenant by slug (public callers do not get to pass UUIDs)
    let resolvedTenantId: string | null = null;
    if (dto.tenantSlug) {
      const tenant = await this.tenantRepo.findOne({
        where: { slug: dto.tenantSlug, isActive: true },
      });
      if (!tenant || tenant.name === 'System Administration') {
        throw new NotFoundException('The selected organization was not found');
      }
      resolvedTenantId = tenant.id;
    }

    // Check for duplicate pending request
    const existing = await this.accessRequestRepo.findOne({
      where: { email: dto.email, status: AccessRequestStatus.PENDING },
    });
    if (existing) {
      throw new ConflictException('You already have a pending access request. Please wait for it to be reviewed.');
    }

    const request = this.accessRequestRepo.create({
      name: dto.name,
      email: dto.email,
      message: dto.message || null,
      tenantId: resolvedTenantId,
      newTenantName: dto.newTenantName || null,
      status: AccessRequestStatus.PENDING,
    });

    const saved = await this.accessRequestRepo.save(request);
    return this.toResponse(saved);
  }

  /**
   * List pending requests for admin's tenant
   */
  async findPendingForTenant(tenantId: string): Promise<AccessRequestResponse[]> {
    const requests = await this.accessRequestRepo.find({
      where: { tenantId, status: AccessRequestStatus.PENDING },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(requests.map((r) => this.toResponse(r)));
  }

  /**
   * List all pending requests (super admin)
   */
  async findAllPending(): Promise<AccessRequestResponse[]> {
    const requests = await this.accessRequestRepo.find({
      where: { status: AccessRequestStatus.PENDING },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(requests.map((r) => this.toResponse(r)));
  }

  /**
   * Approve an access request (admin or super admin)
   * Uses a DB transaction so tenant creation, user creation, and request update
   * are atomic — if any step fails, all changes are rolled back.
   */
  async approve(
    requestId: string,
    reviewerId: string,
    reviewerRole: UserRole,
    reviewerTenantId: string,
    dto?: ApproveAccessRequestDto,
  ): Promise<{ message: string }> {
    const request = await this.accessRequestRepo.findOne({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Access request not found');
    }
    if (request.status !== AccessRequestStatus.PENDING) {
      throw new BadRequestException('This request has already been reviewed');
    }

    // Check if user already exists (before transaction)
    const existingUser = await this.userRepo.findOne({
      where: { email: request.email },
    });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists. Each email can only be associated with one account.');
    }

    // Run tenant creation + user creation + request update in a transaction
    return this.dataSource.transaction(async (manager) => {
      // Determine target tenant
      let targetTenantId: string;

      if (request.tenantId) {
        // Joining existing tenant
        if ((reviewerRole === UserRole.TENANT_ADMIN || reviewerRole === UserRole.TENANT_OWNER) && request.tenantId !== reviewerTenantId) {
          throw new BadRequestException('You can only approve requests for your own tenant');
        }
        targetTenantId = request.tenantId;
      } else if (request.newTenantName) {
        // Creating new tenant — only super admin
        if (reviewerRole !== UserRole.PLATFORM_ADMIN) {
          throw new BadRequestException('Only super admins can approve requests for new tenants');
        }
        const slug = this.generateSlug(request.newTenantName);
        const existingTenant = await manager.findOne(Tenant, { where: { slug } });
        if (existingTenant) {
          throw new ConflictException(`Tenant slug "${slug}" already exists`);
        }
        const defaultPlanCode = await this.plansService.getDefaultPlanCodeForNewTenant();
        if (!defaultPlanCode) {
          throw new BadRequestException(
            'Cannot approve: no subscription plans are configured. ' +
            'Please configure at least one plan at /super-admin/plans first.',
          );
        }
        const newTenant = manager.create(Tenant, {
          name: request.newTenantName,
          slug,
          plan: defaultPlanCode,
          settings: {},
          isActive: true,
        });
        const saved = await manager.save(newTenant);
        targetTenantId = saved.id;
      } else {
        // No tenant specified and no new tenant name — assign to reviewer's tenant
        targetTenantId = reviewerTenantId;
      }

      // Determine role
      const userRole = (request.newTenantName && reviewerRole === UserRole.PLATFORM_ADMIN)
        ? UserRole.TENANT_OWNER
        : UserRole.USER;

      // Generate password
      const tempPassword = dto?.password || generateSecurePassword();
      const passwordHash = await hashPassword(tempPassword);

      const user = manager.create(User, {
        tenantId: targetTenantId,
        email: request.email,
        name: request.name,
        passwordHash,
        role: userRole,
        isActive: true,
      });
      await manager.save(user);

      // Mark request as approved
      request.status = AccessRequestStatus.APPROVED;
      request.reviewedBy = reviewerId;
      request.reviewedAt = new Date();
      await manager.save(request);

      this.logger.log(`Access request ${requestId} approved. User ${request.email} created as ${userRole}`);
      return { message: `User ${request.email} has been approved and created as ${userRole}. Temporary password: ${tempPassword}` };
    });
  }

  /**
   * Reject an access request
   */
  async reject(
    requestId: string,
    reviewerId: string,
    reviewerRole: UserRole,
    reviewerTenantId: string,
  ): Promise<{ message: string }> {
    const request = await this.accessRequestRepo.findOne({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Access request not found');
    }
    if (request.status !== AccessRequestStatus.PENDING) {
      throw new BadRequestException('This request has already been reviewed');
    }

    // Admin can only reject requests for their tenant
    if ((reviewerRole === UserRole.TENANT_ADMIN || reviewerRole === UserRole.TENANT_OWNER) && request.tenantId !== reviewerTenantId) {
      throw new BadRequestException('You can only reject requests for your own tenant');
    }

    request.status = AccessRequestStatus.REJECTED;
    request.reviewedBy = reviewerId;
    request.reviewedAt = new Date();
    await this.accessRequestRepo.save(request);

    return { message: `Access request from ${request.email} has been rejected` };
  }

  /**
   * Get list of public tenants (for the access request form).
   *
   * Returns slug + name only — never the UUID. Tenant UUIDs are internal
   * identifiers used in JWTs and tenant-scoped queries; exposing them to
   * unauthenticated callers enables tenant enumeration and targeted
   * IDOR-style attacks. The slug is the human-friendly identifier the
   * public form submits back via `tenantSlug`.
   */
  async getPublicTenants(): Promise<{ slug: string; name: string }[]> {
    const tenants = await this.tenantRepo.find({
      where: { isActive: true },
      select: ['slug', 'name'],
      order: { name: 'ASC' },
    });
    // Filter out 'system' tenant
    return tenants
      .filter((t) => t.name !== 'System Administration')
      .map((t) => ({ slug: t.slug, name: t.name }));
  }

  private async toResponse(request: AccessRequest): Promise<AccessRequestResponse> {
    let tenantName: string | null = null;
    if (request.tenantId) {
      const tenant = await this.tenantRepo.findOne({ where: { id: request.tenantId } });
      tenantName = tenant?.name || null;
    }
    return {
      id: request.id,
      name: request.name,
      email: request.email,
      message: request.message,
      tenantId: request.tenantId,
      tenantName,
      newTenantName: request.newTenantName,
      status: request.status,
      reviewedBy: request.reviewedBy,
      reviewedAt: request.reviewedAt,
      createdAt: request.createdAt,
    };
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) + '-' + uuidv4().substring(0, 8);
  }

}
