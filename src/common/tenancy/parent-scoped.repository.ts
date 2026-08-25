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

import { LIVE_SENTINEL_SQL } from '../database/base.entity';
import { requireTenantId } from '../context/request-context';

/**
 * A repository for entities that reach their tenant through a parent.
 *
 * `option_sets` carries `tenant_id`; groups, options, values, rules, versions and
 * assignments do not. They reach it by joining upward — one hop for a group, two
 * for an option, three for a value.
 *
 * ## Why not denormalise `tenant_id` onto all six
 *
 * It would let [`TenantScopedRepository`](./tenant-scoped.repository.ts) cover
 * them unchanged, and it would create six places for the column to disagree with
 * the parent. A row whose `tenant_id` says one tenant while its `option_set_id`
 * says another is worse than no column: every query looks scoped and one of them
 * is lying, and nothing in the schema can say which.
 *
 * ## Why the join rather than a verified parent
 *
 * The alternative is loading the parent, checking its tenant once, and then
 * querying children unscoped. That is faster and it is a rule someone has to
 * remember — and a child query that skips the check returns another tenant's rows
 * with no error anywhere.
 *
 * This filters in SQL on every read and every write. The predicate is not
 * something a caller can forget, because there is no method that omits it.
 *
 * ## The cost, stated plainly
 *
 * Every query carries one to three joins it would not otherwise need. They are
 * primary-key joins on indexed columns, and the alternative is a correctness
 * guarantee that depends on nobody making a mistake.
 */
export abstract class ParentScopedRepository<T extends ObjectLiteral & { id: string }> {
  protected constructor(
    protected readonly repository: Repository<T>,
    /** Alias for this entity in generated SQL. */
    private readonly alias: string,
    /**
     * The join path from this entity up to `option_sets`, nearest parent first.
     *
     * `options` is `[{ table: 'option_groups', on: 'optionGroupId' },
     *                { table: 'option_sets',   on: 'optionSetId' }]`.
     */
    private readonly chain: ReadonlyArray<{ table: string; on: string }>,
  ) {}

  /**
   * The tenant every query is scoped to.
   *
   * Read per call rather than cached: repositories are singletons and requests
   * are concurrent, so a cached tenant would be one request's identity answering
   * another's query.
   */
  protected get tenantId(): string {
    return requireTenantId();
  }

  /**
   * A query builder already joined up to `option_sets` and filtered by tenant.
   *
   * Every read goes through this. The joins are built from `chain` rather than
   * written per entity, so a new entity declares its path and inherits the
   * scoping instead of reimplementing it.
   */
  protected scoped(): SelectQueryBuilder<T> {
    const query = this.repository.createQueryBuilder(this.alias);

    let child = this.alias;

    this.chain.forEach((link, index) => {
      const parent = `p${index}`;

      /**
       * Every link excludes soft-deleted parents.
       *
       * Joining on `id` alone leaves a deleted option set still exposing its
       * groups, options and values — verified before this was added: deleting a
       * set left its option still counted. M7.2 requires a deleted set to
       * exclude its contents, and "the parent is gone but its children are
       * listed" is a bug a merchant reports as data they cannot remove.
       *
       * A live row is `deleted_at = LIVE_SENTINEL`, never NULL (ADR-014), so
       * this is an equality rather than a null check.
       */
      query.innerJoin(
        link.table,
        parent,
        `${parent}.id = ${child}.${link.on} AND ${parent}.deletedAt = :liveSentinel`,
      );
      child = parent;
    });

    return query
      .andWhere(`${child}.tenantId = :tenantId`, { tenantId: this.tenantId })
      // The entity's own soft-delete state, not only its parents'.
      .andWhere(`${this.alias}.deletedAt = :liveSentinel`)
      .setParameter('liveSentinel', LIVE_SENTINEL_SQL);
  }

  async find(options: FindManyOptions<T> = {}): Promise<T[]> {
    const query = this.scoped();

    applyWhere(query, this.alias, options.where);
    applyOrder(query, this.alias, options.order);

    if (options.take !== undefined) {
      query.take(options.take);
    }

    if (options.skip !== undefined) {
      query.skip(options.skip);
    }

    return query.getMany();
  }

  async findOne(options: FindOneOptions<T>): Promise<T | null> {
    const query = this.scoped();

    applyWhere(query, this.alias, options.where);

    return query.getOne();
  }

  /**
   * Find by id, within this tenant.
   *
   * Returns null for an id belonging to another tenant — the same answer as an id
   * that does not exist. Distinguishing them would let a caller walk ids and
   * learn which belong to someone else (ADR-010).
   */
  async findById(id: string): Promise<T | null> {
    return this.scoped().andWhere(`${this.alias}.id = :id`, { id }).getOne();
  }

  async count(options: FindManyOptions<T> = {}): Promise<number> {
    const query = this.scoped();

    applyWhere(query, this.alias, options.where);

    return query.getCount();
  }

  async exists(where: FindOptionsWhere<T>): Promise<boolean> {
    const query = this.scoped();

    applyWhere(query, this.alias, where);

    return (await query.getCount()) > 0;
  }

  /**
   * Create a row under a parent this tenant owns.
   *
   * **The parent is verified before the insert**, because an insert has no row to
   * join from — the scoping predicate has nothing to filter until the row exists.
   * That makes this the one operation where the check is separate from the write,
   * and it is why `parentId` is a required argument rather than part of `data`:
   * a caller cannot supply it without this method seeing it.
   */
  async create(parentId: string, data: DeepPartial<T>): Promise<T> {
    await this.assertParentOwned(parentId);

    return this.repository.save(this.repository.create(data));
  }

  /**
   * Update rows this tenant owns.
   *
   * MySQL cannot join in an `UPDATE` through TypeORM's builder, so the ids are
   * resolved through the scoped read first and the update is constrained to them.
   * A row outside the tenant is never in that set.
   */
  async update(where: FindOptionsWhere<T>, data: Partial<T>): Promise<UpdateResult> {
    const ids = await this.scopedIds(where);

    if (ids.length === 0) {
      return { affected: 0, generatedMaps: [], raw: [] };
    }

    return this.repository
      .createQueryBuilder()
      .update()
      .set(data as never)
      .whereInIds(ids)
      .execute();
  }

  async delete(where: FindOptionsWhere<T>): Promise<DeleteResult> {
    const ids = await this.scopedIds(where);

    if (ids.length === 0) {
      return { affected: 0, raw: [] };
    }

    return this.repository.createQueryBuilder().delete().whereInIds(ids).execute();
  }

  /**
   * Save an entity this tenant owns.
   *
   * Verified rather than assumed: an entity loaded elsewhere, or built by hand,
   * could belong to another tenant, and `save` would happily write it.
   */
  async save(entity: T): Promise<T> {
    if ((await this.findById(entity.id)) === null) {
      throw new Error(
        `Refusing to save ${this.alias} ${entity.id}: it does not belong to tenant ` +
          `${this.tenantId}.`,
      );
    }

    return this.repository.save(entity);
  }

  /** Ids matching a predicate, already tenant-filtered. */
  private async scopedIds(where: FindOptionsWhere<T>): Promise<string[]> {
    const query = this.scoped().select(`${this.alias}.id`, 'id');

    applyWhere(query, this.alias, where);

    const rows: Array<{ id: string }> = await query.getRawMany();

    return rows.map((row) => row.id);
  }

  /**
   * Confirm a parent belongs to this tenant.
   *
   * Walks the same chain a read would, starting one link up.
   */
  private async assertParentOwned(parentId: string): Promise<void> {
    const [nearest, ...rest] = this.chain;

    const query = this.repository.manager
      .createQueryBuilder()
      .select('1')
      .from(nearest.table, 'p');

    let child = 'p';

    rest.forEach((link, index) => {
      const parent = `a${index}`;

      query.innerJoin(link.table, parent, `${parent}.id = ${child}.${link.on}`);
      child = parent;
    });

    const owned = await query
      .where('p.id = :parentId', { parentId })
      .andWhere(`${child}.tenantId = :tenantId`, { tenantId: this.tenantId })
      // A deleted parent cannot receive new children.
      .andWhere('p.deletedAt = :liveSentinel', { liveSentinel: LIVE_SENTINEL_SQL })
      .getRawOne();

    if (!owned) {
      // Same answer as a parent that does not exist — a caller must not learn
      // that an id is real but belongs to someone else.
      throw new Error(`Parent ${parentId} not found.`);
    }
  }

  /**
   * The underlying repository, for a query this surface cannot express.
   *
   * **Unscoped.** The name is deliberately unpleasant so it cannot be reached for
   * absent-mindedly and cannot pass review unnoticed.
   */
  protected get unsafeUnscopedRepository(): Repository<T> {
    return this.repository;
  }

  protected get manager(): EntityManager {
    return this.repository.manager;
  }
}

/** Apply a caller's `where` to a builder, qualified by alias. */
function applyWhere<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  alias: string,
  where?: FindOptionsWhere<T> | FindOptionsWhere<T>[],
): void {
  if (!where || Array.isArray(where)) {
    // Arrays are an OR of conditions; the tenant predicate is already applied to
    // the whole query with andWhere, so an OR cannot widen past it.
    return;
  }

  Object.entries(where).forEach(([field, value]) => {
    query.andWhere(`${alias}.${field} = :w_${field}`, { [`w_${field}`]: value });
  });
}

/** Apply a caller's `order`, qualified by alias. */
function applyOrder<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  alias: string,
  order?: FindManyOptions<T>['order'],
): void {
  if (!order) {
    return;
  }

  Object.entries(order).forEach(([field, direction]) => {
    query.addOrderBy(`${alias}.${field}`, direction === 'DESC' ? 'DESC' : 'ASC');
  });
}
