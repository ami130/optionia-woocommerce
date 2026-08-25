import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
 * Encode a cursor.
 *
 * base64url of the sort key. Opaque by construction rather than by convention:
 * a client cannot read it, so it cannot come to depend on the ordering, and
 * changing that ordering later does not break anyone.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or null if it is unusable.
 *
 * A malformed cursor returns the first page rather than an error. It arrives
 * from a URL a user may have edited or truncated, and answering "your cursor is
 * invalid" to someone who pasted a link is worse than showing them page one.
 */
function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) {
    return null;
  }

  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(timestamp);

    if (!id || Number.isNaN(createdAt.getTime())) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
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
