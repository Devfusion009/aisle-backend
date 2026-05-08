import { NotFoundException } from '@nestjs/common';
import {
  Repository,
  DataSource,
  FindOptionsWhere,
  FindOptionsOrder,
  FindOptionsRelations,
  ObjectLiteral,
  SelectQueryBuilder,
  DeepPartial,
  EntityManager,
  In,
} from 'typeorm';

// ── Shared types ─────────────────────────────────────────────────────────

export interface PaginationOpts {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface FindOpts<T extends ObjectLiteral> {
  where?: FindOptionsWhere<T> | FindOptionsWhere<T>[];
  relations?: FindOptionsRelations<T>;
  select?: (keyof T)[];
  order?: FindOptionsOrder<T>;
}

export interface DateRange {
  from: Date;
  to?: Date;
  field?: string; // defaults to 'createdAt'
}

// Playground conversation title prefix used across the app
export const PLAYGROUND_PREFIX = '__pg__';

// ── Base Repository ──────────────────────────────────────────────────────

/**
 * Generic tenant-scoped repository.
 *
 * Every method that touches data takes `tenantId` as its first argument,
 * ensuring tenant isolation can never be accidentally skipped.
 *
 * Specialized repos extend this class and add entity-specific queries.
 */
export class BaseRepository<T extends ObjectLiteral> {
  constructor(
    protected readonly repo: Repository<T>,
    protected readonly ds: DataSource,
  ) {}

  /** Expose the underlying TypeORM repository for edge cases */
  get raw(): Repository<T> {
    return this.repo;
  }

  /** Human-readable entity name (for error messages) */
  protected get entityName(): string {
    return this.repo.metadata.name;
  }

  // ── Query builder helpers ────────────────────────────────────────────

  /** Create a query builder pre-scoped to a tenant */
  qb(alias: string, tenantId: string): SelectQueryBuilder<T> {
    return this.repo
      .createQueryBuilder(alias)
      .where(`${alias}.tenantId = :tenantId`, { tenantId });
  }

  /** Apply a date range to an existing query builder */
  applyDateRange(
    query: SelectQueryBuilder<T>,
    alias: string,
    range: DateRange,
  ): SelectQueryBuilder<T> {
    const field = range.field ?? 'createdAt';
    query.andWhere(`${alias}.${field} >= :from`, { from: range.from });
    if (range.to) {
      query.andWhere(`${alias}.${field} <= :to`, { to: range.to });
    }
    return query;
  }

  // ── Read operations ──────────────────────────────────────────────────

  /** Find one entity by ID within a tenant */
  async findById(
    tenantId: string,
    id: string,
    opts?: FindOpts<T>,
  ): Promise<T | null> {
    return this.repo.findOne({
      where: { tenantId, id, ...opts?.where } as FindOptionsWhere<T>,
      relations: opts?.relations as any,
      select: opts?.select as any,
      order: opts?.order,
    });
  }

  /** Find one by ID or throw NotFoundException */
  async findByIdOrFail(
    tenantId: string,
    id: string,
    opts?: FindOpts<T>,
  ): Promise<T> {
    const entity = await this.findById(tenantId, id, opts);
    if (!entity) throw new NotFoundException(`${this.entityName} not found`);
    return entity;
  }

  /** Find one entity matching conditions within a tenant */
  async findOne(
    tenantId: string,
    where: FindOptionsWhere<T>,
    opts?: Omit<FindOpts<T>, 'where'>,
  ): Promise<T | null> {
    return this.repo.findOne({
      where: { tenantId, ...where } as FindOptionsWhere<T>,
      relations: opts?.relations as any,
      select: opts?.select as any,
      order: opts?.order,
    });
  }

  /** Find one or throw */
  async findOneOrFail(
    tenantId: string,
    where: FindOptionsWhere<T>,
    opts?: Omit<FindOpts<T>, 'where'>,
  ): Promise<T> {
    const entity = await this.findOne(tenantId, where, opts);
    if (!entity) throw new NotFoundException(`${this.entityName} not found`);
    return entity;
  }

  /** Find all entities within a tenant */
  async findAll(
    tenantId: string,
    opts?: FindOpts<T> & { take?: number },
  ): Promise<T[]> {
    return this.repo.find({
      where: { tenantId, ...opts?.where } as FindOptionsWhere<T>,
      relations: opts?.relations as any,
      select: opts?.select as any,
      order: opts?.order ?? ({ createdAt: 'DESC' } as any),
      take: opts?.take,
    });
  }

  /** Find with pagination (page & limit are clamped to safe ranges) */
  async findPaginated(
    tenantId: string,
    pagination: PaginationOpts,
    opts?: FindOpts<T>,
  ): Promise<PaginatedResult<T>> {
    const page = Math.max(1, pagination.page ?? 1);
    const limit = Math.min(Math.max(1, pagination.limit ?? 20), 200);

    const [data, total] = await this.repo.findAndCount({
      where: { tenantId, ...opts?.where } as FindOptionsWhere<T>,
      relations: opts?.relations as any,
      select: opts?.select as any,
      order: opts?.order ?? ({ createdAt: 'DESC' } as any),
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ── Aggregation ──────────────────────────────────────────────────────

  /** Count entities matching conditions within a tenant */
  async count(tenantId: string, where?: FindOptionsWhere<T>): Promise<number> {
    return this.repo.count({
      where: { tenantId, ...where } as unknown as FindOptionsWhere<T>,
    });
  }

  /** Check existence */
  async exists(tenantId: string, where: FindOptionsWhere<T>): Promise<boolean> {
    return (
      (await this.repo.count({
        where: { tenantId, ...where } as unknown as FindOptionsWhere<T>,
        take: 1,
      })) > 0
    );
  }

  // ── Write operations ─────────────────────────────────────────────────

  /** Create and persist a new entity (tenantId is injected automatically) */
  async create(tenantId: string, data: DeepPartial<T>): Promise<T> {
    const entity = this.repo.create({ tenantId, ...data } as any);
    return this.repo.save(entity) as unknown as Promise<T>;
  }

  /** Create within a transaction manager */
  async createWith(
    manager: EntityManager,
    tenantId: string,
    data: DeepPartial<T>,
  ): Promise<T> {
    const r = manager.getRepository<T>(this.repo.target as any);
    const entity = r.create({ tenantId, ...data } as any);
    return r.save(entity) as unknown as Promise<T>;
  }

  /** Update an existing entity by ID (fetches first to ensure ownership) */
  async update(
    tenantId: string,
    id: string,
    data: DeepPartial<T>,
  ): Promise<T> {
    const entity = await this.findByIdOrFail(tenantId, id);
    Object.assign(entity, data);
    return this.repo.save(entity);
  }

  /** Partial update — only the fields provided are changed (no full fetch) */
  async patch(
    tenantId: string,
    id: string,
    data: Partial<T>,
  ): Promise<void> {
    const result = await this.repo.update(
      { tenantId, id } as any,
      data as any,
    );
    if (result.affected === 0) {
      throw new NotFoundException(`${this.entityName} not found`);
    }
  }

  /** Delete an entity by ID within a tenant */
  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.repo.delete({ tenantId, id } as any);
    if (result.affected === 0) {
      throw new NotFoundException(`${this.entityName} not found`);
    }
  }

  // ── Bulk operations ──────────────────────────────────────────────────

  /** Create multiple entities within a tenant */
  async bulkCreate(
    tenantId: string,
    items: DeepPartial<T>[],
  ): Promise<T[]> {
    if (items.length === 0) return [];
    const entities = items.map((item) =>
      this.repo.create({ tenantId, ...item } as any),
    );
    return this.repo.save(entities as any) as Promise<T[]>;
  }

  /** Delete multiple entities by IDs within a tenant */
  async bulkDelete(tenantId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.repo.delete({
      tenantId,
      id: In(ids),
    } as any);
    return result.affected ?? 0;
  }

  // ── Transaction ──────────────────────────────────────────────────────

  /** Run a callback inside a database transaction */
  async transaction<R>(
    fn: (manager: EntityManager) => Promise<R>,
  ): Promise<R> {
    return this.ds.transaction(fn);
  }
}
