import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import {
  AccessRequest,
  AccessRequestStatus,
} from '../entities/access-request.entity';

/**
 * AccessRequest repository.
 *
 * NOTE: This does NOT extend BaseRepository because AccessRequest
 * has a nullable tenantId (new-tenant requests have tenantId = null).
 * Scoping by tenantId is applied only where it makes sense.
 */
@Injectable()
export class AccessRequestRepo {
  constructor(
    @InjectRepository(AccessRequest)
    private readonly repo: Repository<AccessRequest>,
    private readonly ds: DataSource,
  ) {}

  /** Expose raw repo for edge cases */
  get raw(): Repository<AccessRequest> {
    return this.repo;
  }

  // ── Read operations ──────────────────────────────────────────────────

  /** Find by ID */
  async findById(id: string): Promise<AccessRequest | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** Find by ID or throw */
  async findByIdOrFail(id: string): Promise<AccessRequest> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('Access request not found');
    return entity;
  }

  /** Check if a pending request exists for this email */
  async findPendingByEmail(email: string): Promise<AccessRequest | null> {
    return this.repo.findOne({
      where: { email, status: AccessRequestStatus.PENDING },
    });
  }

  /** All pending requests for a specific tenant */
  async findPendingForTenant(tenantId: string): Promise<AccessRequest[]> {
    return this.repo.find({
      where: { tenantId, status: AccessRequestStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
  }

  /** All pending requests globally (for super-admin) */
  async findAllPending(): Promise<AccessRequest[]> {
    return this.repo.find({
      where: { status: AccessRequestStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
  }

  /** All pending new-tenant requests (tenantId IS NULL) */
  async findPendingNewTenant(): Promise<AccessRequest[]> {
    return this.repo.find({
      where: { tenantId: IsNull(), status: AccessRequestStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
  }

  /** Find by status */
  async findByStatus(status: AccessRequestStatus): Promise<AccessRequest[]> {
    return this.repo.find({
      where: { status },
      order: { createdAt: 'DESC' },
    });
  }

  // ── Write operations ─────────────────────────────────────────────────

  /** Create a new access request */
  async create(
    data: Partial<AccessRequest>,
  ): Promise<AccessRequest> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  /** Approve a request */
  async approve(
    id: string,
    reviewedBy: string,
  ): Promise<AccessRequest> {
    const request = await this.findByIdOrFail(id);
    request.status = AccessRequestStatus.APPROVED;
    request.reviewedBy = reviewedBy;
    request.reviewedAt = new Date();
    return this.repo.save(request);
  }

  /** Reject a request */
  async reject(
    id: string,
    reviewedBy: string,
  ): Promise<AccessRequest> {
    const request = await this.findByIdOrFail(id);
    request.status = AccessRequestStatus.REJECTED;
    request.reviewedBy = reviewedBy;
    request.reviewedAt = new Date();
    return this.repo.save(request);
  }

  /** Count pending requests (for badges / notifications) */
  async countPending(tenantId?: string): Promise<number> {
    const where: any = { status: AccessRequestStatus.PENDING };
    if (tenantId) where.tenantId = tenantId;
    return this.repo.count({ where });
  }
}
