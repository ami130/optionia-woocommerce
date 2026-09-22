import {
  DeepPartial,
  DeleteResult,
  EntityManager,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
  UpdateResult,
} from 'typeorm';

import { requireTenantId } from '../context/request-context';
import { LIVE_SENTINEL_SQL } from '../database/base.entity';

/**
 * A repository that cannot return another tenant's rows.
 *
 * **The core of AC5.** Every query it issues carries a `tenantId` predicate taken
 * from the request context, and there is no method that skips it.
 *
 * ## Why this does not extend `Repository`
 *
 * `Repository` exposes 31 read and write methods plus `createQueryBuilder`,
 * `query` and `manager`. Extending it and overriding the ones that matter means
 * the safety of the whole system depends on nobody calling the ones that were
 * missed — and `findByIds`, `existsBy`, `sum`, `updateAll` and `deleteAll` are
 * all easy to miss. A base class with an inherited unscoped `find` is not a
 * boundary; it is a boundary with an unlocked door beside it.
 *
 * So this **wraps** a repository and exposes a deliberately small surface. A
 * method that is not here does not exist for tenant data, and adding one is a
 * visible, reviewable act rather than an inherited default.
 *
 * ## Why it throws
 *
 * `requireTenantId()` throws when the context has no tenant. That is the point:
 * a missing tenant must never become an unscoped query. A thrown exception is a
 * 500 someone fixes; a silent unscoped read is every row in the table returned to
 * whoever asked.
 *
 * Code that legitimately has no tenant — migrations, seeds, platform admin
 * routes — must not use this class. It reaches for the plain repository and is
 * visible in review for doing so.
 */
export abstract class TenantScopedRepository<
  T extends ObjectLiteral & { id: string; tenantId: string },
> {
  protected constructor(protected readonly repository: Repository<T>) {}

  /**
   * The tenant every query is scoped to.
   *
   * Read per call rather than cached on the instance: repositories are
   * singletons and requests are concurrent, so a cached tenant would be one
   * request's identity answering another's query.
   */
  protected get tenantId(): string {
    return requireTenantId();
  }

  /** Merge the tenant predicate into a caller's `where`. */
  private scopedWhere(
    where?: FindOptionsWhere<T> | FindOptionsWhere<T>[],
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    const tenantId = this.tenantId;

    /**
     * Soft-deleted rows are excluded on entities that support it.
     *
     * Without this a deleted option set still appeared in every list and
     * `findById` still returned it — verified before the fix. `@DeleteDateColumn`
     * is deliberately not used (ADR-014), so TypeORM does not filter these
     * automatically and the predicate has to be explicit.
     *
     * The literal rather than the `Date`: passing `LIVE_SENTINEL` as a parameter
     * makes the driver convert it to local time and match nothing at all.
     */
    const live = this.isSoftDeletable
      ? { deletedAt: LIVE_SENTINEL_SQL as unknown }
      : {};

    // An array is an OR. Each branch needs the predicate, or one unscoped branch
    // makes the whole query unscoped.
    if (Array.isArray(where)) {
      return where.map((clause) => ({ ...clause, ...live, tenantId }) as FindOptionsWhere<T>);
    }

    return { ...(where ?? {}), ...live, tenantId } as FindOptionsWhere<T>;
  }

  /** Whether this entity carries `deletedAt`, read once from its metadata. */
  private get isSoftDeletable(): boolean {
    return this.repository.metadata.columns.some((c) => c.propertyName === 'deletedAt');
  }

  async find(options: FindManyOptions<T> = {}): Promise<T[]> {
    return this.repository.find({ ...options, where: this.scopedWhere(options.where) });
  }

  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    return this.repository.findOne({ ...options, where: this.scopedWhere(options.where) });
  }

  /**
   * Find by id, within this tenant.
   *
   * Returns null for an id belonging to another tenant — the same answer as an
   * id that does not exist. That is deliberate: distinguishing them would let a
   * caller walk ids and learn which belong to someone else (ADR-010).
   */
  async findById(id: string): Promise<T | null> {
    return this.findOne({ where: { id } as FindOptionsWhere<T> });
  }

  async findAndCount(options: FindManyOptions<T> = {}): Promise<[T[], number]> {
    return this.repository.findAndCount({
      ...options,
      where: this.scopedWhere(options.where),
    });
  }

  async count(options: FindManyOptions<T> = {}): Promise<number> {
    return this.repository.count({ ...options, where: this.scopedWhere(options.where) });
  }

  async exists(where: FindOptionsWhere<T>): Promise<boolean> {
    return this.repository.exists({ where: this.scopedWhere(where) });
  }

  /**
   * Create a new row in this tenant.
   *
   * The tenant is stamped here rather than trusted from the caller. A payload
   * carrying `tenantId` cannot write into another tenant, because the value is
   * overwritten after the spread.
   */
  async create(data: DeepPartial<Omit<T, 'tenantId'>>): Promise<T> {
    const entity = this.repository.create({
      ...(data as DeepPartial<T>),
      tenantId: this.tenantId,
    } as DeepPartial<T>);

    return this.repository.save(entity);
  }

  /**
   * Update rows matching a predicate, within this tenant.
   *
   * `tenantId` is stripped from the payload before the update: allowing it
   * through would let a caller move a row into another tenant, which is a write
   * leak rather than a read one and just as bad.
   */
  async update(
    where: FindOptionsWhere<T>,
    data: Partial<Omit<T, 'tenantId'>>,
  ): Promise<UpdateResult> {
    const safe = { ...(data as Partial<T> & { tenantId?: string }) };
    delete safe.tenantId;

    return this.repository.update(
      this.scopedWhere(where) as FindOptionsWhere<T>,
      safe as never,
    );
  }

  async delete(where: FindOptionsWhere<T>): Promise<DeleteResult> {
    return this.repository.delete(this.scopedWhere(where) as FindOptionsWhere<T>);
  }

  /**
   * Save an entity that already belongs to this tenant.
   *
   * Verified rather than assumed: an entity loaded elsewhere, or built by hand,
   * could carry another tenant's id, and `save` would happily write it.
   */
  async save(entity: T): Promise<T> {
    const tenantId = this.tenantId;

    if (entity.tenantId !== tenantId) {
      throw new Error(
        `Refusing to save an entity belonging to tenant ${String(entity.tenantId)} ` +
          `while acting as ${tenantId}.`,
      );
    }

    return this.repository.save(entity);
  }

  /**
   * A query builder already filtered by tenant and soft-delete state.
   *
   * `FindManyOptions` cannot express cursor pagination with a search, and the
   * alternative — handing callers `unsafeUnscopedRepository` and trusting them to
   * re-apply the predicate — is the failure this class exists to prevent. A
   * subclass renaming that accessor to something reassuring would be the same
   * hole with a better name.
   *
   * So the builder arrives pre-scoped. A caller adds ordering, limits and their
   * own conditions on top, and cannot remove what is already there.
   */
  protected scopedQuery(alias: string): SelectQueryBuilder<T> {
    const query = this.repository
      .createQueryBuilder(alias)
      .where(`${alias}.tenantId = :tenantId`, { tenantId: this.tenantId });

    if (this.isSoftDeletable) {
      query.andWhere(`${alias}.deletedAt = :liveSentinel`, {
        liveSentinel: LIVE_SENTINEL_SQL,
      });
    }

    return query;
  }

  /**
   * The underlying repository, for a query this surface cannot express.
   *
   * **Unscoped.** The name is deliberately unpleasant so it cannot be reached for
   * absent-mindedly and cannot pass review unnoticed. Whoever uses it owns the
   * predicate, and `this.tenantId` is how they get it.
   */
  protected get unsafeUnscopedRepository(): Repository<T> {
    return this.repository;
  }

  /** The entity manager, for a caller running inside a transaction. */
  protected get manager(): EntityManager {
    return this.repository.manager;
  }
}
