import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionRule } from './entities/option-rule.entity';
import { OptionSetAssignment } from './entities/option-set-assignment.entity';
import { OptionSetVersion } from './entities/option-set-version.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';

/** What a hard delete removed. */
export interface PurgeResult {
  readonly groups: number;
  readonly options: number;
  readonly values: number;
  readonly rules: number;
  readonly assignments: number;
  readonly versions: number;
}

/**
 * Permanent removal (M7.2, "Delete (hard)").
 *
 * **Only permitted when no order ever referenced it.** That precondition is not
 * referential integrity — it is the protection ADR-016 describes from the other
 * side.
 *
 * `order_selections` stores `option_key` and `value_key` as denormalized values
 * with **no foreign key**, precisely so an order survives its option being
 * deleted: an order is a historical fact, and what the customer chose and was
 * charged does not change because a merchant tidied up later. Phase 4 proved the
 * alternative — a foreign key would either block the delete or cascade the order
 * away, both wrong.
 *
 * The consequence is that nothing in the schema stops a hard delete from
 * orphaning the meaning of an order line: the row survives, but the option it
 * names is gone, and "Finish: Luxury" becomes unexplainable. Soft delete is
 * therefore the default, and this exists for the case a soft delete cannot
 * serve — a set built by mistake, or one a merchant is entitled to have erased.
 *
 * Because there is no key to join on, the check matches `option_key` **within
 * the same store**. That is deliberately conservative: a key repeated across two
 * of a merchant's sets blocks both. Refusing a delete that might have been safe
 * is recoverable; permitting one that destroys the meaning of an order is not.
 */
@Injectable()
export class HardDeleteService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Erase a set and everything under it.
   *
   * Rows are removed with `delete`, not marked: this is the operation whose
   * whole purpose is that nothing remains.
   */
  async purge(set: OptionSet): Promise<PurgeResult> {
    await this.assertNeverOrdered(set);

    return this.dataSource.transaction(async (manager) => {
      const groupIds = await allIds(manager, OptionGroup, { optionSetId: set.id });
      const optionIds = groupIds.length
        ? await allIds(manager, Option, { optionGroupId: In(groupIds) })
        : [];
      const valueIds = optionIds.length
        ? await allIds(manager, OptionValue, { optionId: In(optionIds) })
        : [];

      // Children first: `option_values` has a foreign key to `options`, so the
      // reverse order fails on the constraint rather than cascading.
      const values = await hardDelete(manager, OptionValue, valueIds);
      const options = await hardDelete(manager, Option, optionIds);
      const groups = await hardDelete(manager, OptionGroup, groupIds);
      const rules = await hardDelete(
        manager,
        OptionRule,
        await allIds(manager, OptionRule, { optionSetId: set.id }),
      );
      const assignments = await hardDelete(
        manager,
        OptionSetAssignment,
        await allIds(manager, OptionSetAssignment, { optionSetId: set.id }),
      );
      const versions = await hardDelete(
        manager,
        OptionSetVersion,
        await allIds(manager, OptionSetVersion, { optionSetId: set.id }),
      );

      await manager.delete(OptionSet, { id: set.id });

      return { groups, options, values, rules, assignments, versions };
    });
  }

  /**
   * Refuse when any order ever named one of this set's option keys.
   *
   * Soft-deleted children are included: an option deleted last week may still be
   * the one an order from last month refers to, and ignoring it would let a
   * two-step delete erase what a one-step delete refuses.
   */
  private async assertNeverOrdered(set: OptionSet): Promise<void> {
    const keys: Array<{ optionKey: string }> = await this.dataSource.query(
      `SELECT DISTINCT o.\`key\` AS optionKey
         FROM options o
         JOIN option_groups g ON g.id = o.optionGroupId
        WHERE g.optionSetId = ?`,
      [set.id],
    );

    if (keys.length === 0) {
      return;
    }

    const [row] = await this.dataSource.query(
      `SELECT COUNT(*) AS referenced
         FROM order_selections os
         JOIN order_events oe ON oe.id = os.orderEventId
        WHERE oe.storeId = ? AND os.optionKey IN (?)`,
      [set.storeId, keys.map((key) => key.optionKey)],
    );

    const referenced = Number(row?.referenced ?? 0);

    if (referenced > 0) {
      throw DomainException.conflict(
        `This option set cannot be permanently deleted: ${referenced} order ` +
          `line${referenced === 1 ? '' : 's'} still refer${referenced === 1 ? 's' : ''} to it. ` +
          `Delete it normally instead — it will be hidden without changing order history.`,
      );
    }
  }
}

/** Every id matching a condition, deleted rows included. */
async function allIds<T extends { id: string }>(
  manager: EntityManager,
  entity: new () => T,
  where: Record<string, unknown>,
): Promise<string[]> {
  /**
   * No soft-delete predicate, deliberately — and **no `withDeleted` either**.
   *
   * `deletedAt` is a plain column holding a sentinel (ADR-014), not TypeORM's
   * `@DeleteDateColumn`, so the ORM has no notion of soft deletion here and
   * `withDeleted` would be a no-op that reads as a safeguard. Every row matching
   * the parent is returned because none of these queries filters on `deletedAt`
   * at all, which is exactly what a hard delete needs: the children of a set
   * are usually *already* soft-deleted by the cascade, and skipping them would
   * erase the parent while orphaning everything under it.
   */
  const rows = await manager.find(entity, {
    where: where as never,
    select: { id: true } as never,
  });

  return rows.map((row) => row.id);
}

async function hardDelete<T>(
  manager: EntityManager,
  entity: new () => T,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const result = await manager.delete(entity, { id: In(ids) } as never);

  return result.affected ?? 0;
}
