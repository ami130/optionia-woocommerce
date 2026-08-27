import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { decodeCursor, encodeCursor } from '../common/pagination/keyset-cursor';
import { TenantScopedRepository } from '../common/tenancy/tenant-scoped.repository';
import type { OptionSetStatus } from '../common/database/enums';
import { OptionSet } from './entities/option-set.entity';

export interface ListFilters {
  readonly status?: OptionSetStatus;
  readonly storeId?: string;
  readonly q?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListPage {
  readonly items: OptionSet[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Option sets, tenant-scoped.
 *
 * `option_sets` carries `tenant_id` directly, so the predicate is a column
 * comparison rather than a join chain.
 */
@Injectable()
export class OptionSetsRepository extends TenantScopedRepository<OptionSet> {
  constructor(
    @InjectRepository(OptionSet)
    repository: Repository<OptionSet>,
  ) {
    super(repository);
  }

  /**
   * One set, **including a soft-deleted one**, still tenant-scoped.
   *
   * Every other read hides deleted rows, which is right: a deleted set is gone
   * as far as authoring is concerned. Permanent deletion is the exception — the
   * natural path is delete, reconsider, then erase, and a purge that could only
   * reach live sets would make the discarded ones unreachable forever.
   *
   * Tenant scoping is unchanged, so this widens what a caller can see of their
   * own data and nothing else.
   */
  async findByIdIncludingDeleted(id: string): Promise<OptionSet | null> {
    return this.unsafeUnscopedRepository
      .createQueryBuilder('s')
      .where('s.id = :id', { id })
      .andWhere('s.tenantId = :tenantId', { tenantId: this.tenantId })
      .getOne();
  }

  /**
   * Apply a change and advance the row's version in the same statement.
   *
   * `rowVersion` is the optimistic lock 7j turns into a 409. It is incremented
   * here, at the single point every mutation passes through, rather than in
   * each caller — a mutation that forgets to bump it makes a *stale* client
   * look current, which is the one failure optimistic locking exists to stop.
   *
   * `rowVersion + 1` is computed by the database, not read-then-written, so two
   * concurrent updates cannot land on the same number.
   */
  async applyChange(
    id: string,
    changes: Partial<OptionSet>,
    expectedRowVersion?: number,
  ): Promise<number> {
    const query = this.unsafeUnscopedRepository
      .createQueryBuilder()
      .update(OptionSet)
      .set({ ...changes, rowVersion: () => 'rowVersion + 1' } as never)
      // The tenant predicate is restated here because this bypasses the
      // scoped `update()` in order to compute `rowVersion` in SQL. It is the
      // one place in this class where scoping is written by hand, so it is
      // covered by an isolation test of its own.
      .where('id = :id', { id })
      .andWhere('tenantId = :tenantId', { tenantId: this.tenantId })
      .andWhere('deletedAt = :liveSentinel', { liveSentinel: LIVE_SENTINEL_SQL });

    /**
     * The optimistic lock, as a **predicate on the write** (M7.4b).
     *
     * Reading the version, comparing it, then writing leaves a window in which
     * another editor commits between the two — and the check would pass on a
     * value that is already stale by the time the update runs. Making it part
     * of the `WHERE` means the database decides: exactly one of two concurrent
     * saves matches a row, and the other sees `affected = 0`.
     */
    if (expectedRowVersion !== undefined) {
      query.andWhere('rowVersion = :expectedRowVersion', { expectedRowVersion });
    }

    const result = await query.execute();

    return result.affected ?? 0;
  }

  /**
   * One page of option sets.
   *
   * **Keyset pagination, not offset.** A merchant pages through their sets while
   * editing them, and `OFFSET` silently skips a row when one is inserted above
   * the current page and repeats one when a row is removed. The bug reads as
   * "an option set disappeared", which is unfalsifiable from a support ticket.
   *
   * Ordered by `(createdAt, id)`. `createdAt` alone is not unique — two sets
   * created in the same millisecond would make the cursor ambiguous and drop one
   * — so the primary key breaks the tie and guarantees a total order.
   */
  async list(filters: ListFilters): Promise<ListPage> {
    const query = this.scopedQuery('s');

    if (filters.status) {
      query.andWhere('s.status = :status', { status: filters.status });
    }

    if (filters.storeId) {
      query.andWhere('s.storeId = :storeId', { storeId: filters.storeId });
    }

    if (filters.q) {
      // Prefix match, so an index on `name` can serve this later. A leading
      // wildcard cannot use one, and "contains" on a growing table is the query
      // that quietly becomes a full scan.
      query.andWhere('s.name LIKE :q', { q: `${escapeLike(filters.q)}%` });
    }

    const decoded = decodeCursor(filters.cursor);

    if (decoded) {
      // Strictly after the last row of the previous page, in the same order.
      query.andWhere(
        '(s.createdAt > :createdAt OR (s.createdAt = :createdAt AND s.id > :id))',
        decoded,
      );
    }

    query.orderBy('s.createdAt', 'ASC').addOrderBy('s.id', 'ASC');

    // One extra row answers "is there another page?" without a second COUNT
    // query, which on a filtered table costs as much as the page itself.
    const rows = await query.take(filters.limit + 1).getMany();
    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      hasMore,
      cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

/**
 * Escape a user's search term for `LIKE`.
 *
 * Without this, `%` matches everything and `_` matches any character — so a
 * merchant searching for `discount_50` gets rows they did not ask for, and one
 * searching `%` gets their whole catalogue. Not a security hole, because the
 * value is still parameterised, but a wrong answer.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}
