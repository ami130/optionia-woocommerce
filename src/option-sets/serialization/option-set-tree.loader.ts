import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../../common/database/base.entity';
import { DomainException } from '../../common/errors/domain.exception';
import { OptionGroup } from '../entities/option-group.entity';
import { OptionRule } from '../entities/option-rule.entity';
import { OptionValue } from '../entities/option-value.entity';
import { Option } from '../entities/option.entity';
import { PresentationalItem } from '../entities/presentational-item.entity';
import { OptionSetsRepository } from '../option-sets.repository';
import type { OptionSetTree } from './option-set.serializer';

/**
 * Loads a whole option set for serialization.
 *
 * **Five queries, not five levels of N+1.** A set with 10 groups of 10 options
 * of 5 values is 500 rows; loaded per parent that is 111 round trips, and this
 * runs on every editor render and every publish. One query per level with an
 * `IN` is the same result at constant cost.
 *
 * The fifth is rules (M17.5), which need no `IN` at all — they hang off the set
 * itself, so they cost one query however many there are.
 *
 * The set itself is fetched through the **scoped repository**, so a caller
 * cannot load another tenant's tree. The child queries filter by parent id —
 * they inherit that scoping from the set having been resolved first, which is
 * the only reason they may query by parent alone.
 */
@Injectable()
export class OptionSetTreeLoader {
  constructor(
    private readonly sets: OptionSetsRepository,
    private readonly dataSource: DataSource,
  ) {}

  async load(optionSetId: string): Promise<OptionSetTree> {
    const set = await this.sets.findById(optionSetId);

    if (!set) {
      // Same answer as another tenant's set (ADR-010).
      throw DomainException.notFound('Option set');
    }

    const groups = await this.dataSource.getRepository(OptionGroup).find({
      where: { optionSetId: set.id, deletedAt: LIVE_SENTINEL_SQL as never },
      order: CHILD_ORDER,
    });

    const groupIds = groups.map((group) => group.id);

    const options = groupIds.length
      ? await this.dataSource.getRepository(Option).find({
          where: { optionGroupId: In(groupIds), deletedAt: LIVE_SENTINEL_SQL as never },
          order: CHILD_ORDER,
        })
      : [];

    const items = groupIds.length
      ? await this.dataSource.getRepository(PresentationalItem).find({
          where: { optionGroupId: In(groupIds), deletedAt: LIVE_SENTINEL_SQL as never },
          order: CHILD_ORDER,
        })
      : [];

    const optionIds = options.map((option) => option.id);

    const values = optionIds.length
      ? await this.dataSource.getRepository(OptionValue).find({
          where: { optionId: In(optionIds), deletedAt: LIVE_SENTINEL_SQL as never },
          order: CHILD_ORDER,
        })
      : [];

    /*
     * Rules hang off the SET, not a group, so this needs no id list from above —
     * a fifth query at constant cost, not a fifth level of N+1.
     *
     * `sortOrder` is presentation, not precedence (M17.2 makes evaluation
     * order-independent), so this ordering decides what a merchant reads in the
     * rule list and what the document lists — never which rule wins.
     */
    const rules = await this.dataSource.getRepository(OptionRule).find({
      where: { optionSetId: set.id, deletedAt: LIVE_SENTINEL_SQL as never },
      order: CHILD_ORDER,
    });

    const optionsByGroup = groupBy(options, (option) => option.optionGroupId);
    const itemsByGroup = groupBy(items, (item) => item.optionGroupId);
    const valuesByOption = groupBy(values, (value) => value.optionId);

    return {
      set,
      rules,
      groups: groups.map((group) => ({
        group,
        items: itemsByGroup.get(group.id) ?? [],
        options: (optionsByGroup.get(group.id) ?? []).map((option) => ({
          option,
          values: valuesByOption.get(option.id) ?? [],
        })),
      })),
    };
  }
}

/**
 * The order every child query uses.
 *
 * Exported so a test can assert the tie-break exists. **Ordering is a property
 * of the SQL, not of the rows a particular dataset returns** — removing the
 * `id` clause changes the query and, on today's data, not the result, because
 * InnoDB happens to return these rows in primary-key order. That coincidence
 * depends on the plan the optimizer picks, so asserting the returned order
 * cannot fail while asserting the clause can.
 */
export const CHILD_ORDER = { sortOrder: 'ASC', id: 'ASC' } as const;

/**
 * Bucket rows by a parent id, preserving the order they arrived in.
 *
 * Order matters: the queries sort by `sort_order` then `id`, and the tie-break
 * on `id` is what makes serialization **deterministic**. Two rows sharing a
 * sort order would otherwise come back in whatever order the storage engine
 * chose, and a config document that differs between two builds of unchanged
 * data would make every snapshot diff ([7i]) untrustworthy.
 *
 * ⚠️ **Not provable by test on this data.** Removing the `id` tie-break changes
 * the SQL but not the result, because InnoDB happens to return these rows in
 * primary-key order anyway. That coincidence is not a contract — it depends on
 * the plan the optimizer picks, which changes with indexes and row counts — so
 * the clause stays, and this note records that its test cannot fail today.
 */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();

  rows.forEach((row) => {
    const id = key(row);
    const bucket = buckets.get(id);

    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(id, [row]);
    }
  });

  return buckets;
}
