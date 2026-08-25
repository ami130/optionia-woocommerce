import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { RuleDisabledReason, RuleTargetType } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionRule } from './entities/option-rule.entity';
import { OptionSetAssignment } from './entities/option-set-assignment.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';

/** What a cascade touched, for the audit entry and the response. */
export interface CascadeResult {
  readonly groups: number;
  readonly options: number;
  readonly values: number;
  readonly rules: number;
  readonly assignments: number;
}

const NOTHING: CascadeResult = { groups: 0, options: 0, values: 0, rules: 0, assignments: 0 };

/**
 * The cascade rules of M7.2, stated explicitly rather than inherited from the ORM.
 *
 * ```text
 * delete option_set → soft-deletes groups, options, values, rules, assignments
 * delete group      → soft-deletes its options; rules targeting it are disabled + flagged
 * delete option     → soft-deletes its values; rules referencing it are disabled + flagged
 * delete value      → blocked if it is the target of an enabled rule (explicit error)
 * ```
 *
 * **Why this exists as its own service.** The four rules have four different
 * shapes — one cascades down, two cascade *and* flag sideways, and one refuses
 * outright. Folded into the three CRUD services they would be four behaviours
 * spread across eight endpoints with none of them tested as itself, which is the
 * reason the plan separates 7g from 7f.
 *
 * **Why the reads still work without this.** `ParentScopedRepository` excludes
 * children of a deleted parent at every join, so a deleted set's contents already
 * vanish from every query. That is a *read* guarantee. This is the *write* one:
 * rows are marked deleted so a later hard delete, export or config build sees the
 * same truth as a list endpoint, and so rules pointing at a deleted target are
 * disabled rather than left to fail at evaluation time.
 */
@Injectable()
export class CascadeService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Everything a set owns, in one transaction.
   *
   * A partial cascade leaves rules pointing at options that are gone from every
   * list but still enabled — the exact state M7.2 forbids.
   */
  async onOptionSetDeleted(optionSetId: string, deletedAt: Date): Promise<CascadeResult> {
    return this.dataSource.transaction(async (manager) => {
      const groupIds = await liveIds(manager, OptionGroup, { optionSetId });
      const optionIds = groupIds.length
        ? await liveIds(manager, Option, { optionGroupId: In(groupIds) })
        : [];
      const valueIds = optionIds.length
        ? await liveIds(manager, OptionValue, { optionId: In(optionIds) })
        : [];

      return {
        values: await softDelete(manager, OptionValue, valueIds, deletedAt),
        options: await softDelete(manager, Option, optionIds, deletedAt),
        groups: await softDelete(manager, OptionGroup, groupIds, deletedAt),
        // Rules and assignments belong to the set directly. They are deleted
        // rather than disabled: their owner is gone, so there is nothing left
        // for a merchant to act on.
        rules: await softDelete(
          manager,
          OptionRule,
          await liveIds(manager, OptionRule, { optionSetId }),
          deletedAt,
        ),
        assignments: await softDelete(
          manager,
          OptionSetAssignment,
          await liveIds(manager, OptionSetAssignment, { optionSetId }),
          deletedAt,
        ),
      };
    });
  }

  /** A group's options and their values, plus any rule that targeted them. */
  async onGroupDeleted(groupId: string, deletedAt: Date): Promise<CascadeResult> {
    return this.dataSource.transaction(async (manager) => {
      const optionIds = await liveIds(manager, Option, { optionGroupId: groupId });
      const valueIds = optionIds.length
        ? await liveIds(manager, OptionValue, { optionId: In(optionIds) })
        : [];

      const values = await softDelete(manager, OptionValue, valueIds, deletedAt);
      const options = await softDelete(manager, Option, optionIds, deletedAt);

      // Every target that just disappeared, at all three levels.
      const rules = await disableRulesTargeting(manager, [
        { type: RuleTargetType.GROUP, ids: [groupId] },
        { type: RuleTargetType.OPTION, ids: optionIds },
        { type: RuleTargetType.VALUE, ids: valueIds },
      ]);

      return { ...NOTHING, values, options, rules };
    });
  }

  /** An option's values, plus any rule that targeted the option or those values. */
  async onOptionDeleted(optionId: string, deletedAt: Date): Promise<CascadeResult> {
    return this.dataSource.transaction(async (manager) => {
      const valueIds = await liveIds(manager, OptionValue, { optionId });
      const values = await softDelete(manager, OptionValue, valueIds, deletedAt);

      const rules = await disableRulesTargeting(manager, [
        { type: RuleTargetType.OPTION, ids: [optionId] },
        { type: RuleTargetType.VALUE, ids: valueIds },
      ]);

      return { ...NOTHING, values, rules };
    });
  }

  /**
   * Refuse to delete a value an enabled rule depends on.
   *
   * The one rule in the table that **blocks** rather than cascades. Disabling
   * the rule instead would silently change what a storefront shows: a rule
   * saying "hide shipping when Gift Wrap is chosen" stops hiding it, and the
   * merchant discovers that from a customer.
   *
   * Deleting the *option* is allowed and disables the rule, because that is an
   * unambiguous instruction about the whole thing. Removing one value out from
   * under a live rule is not.
   */
  async assertValueIsNotRuleTarget(valueId: string): Promise<void> {
    const blocking = await this.dataSource.getRepository(OptionRule).count({
      where: {
        targetType: RuleTargetType.VALUE,
        targetId: valueId,
        isEnabled: true,
        deletedAt: LIVE_SENTINEL_SQL as never,
      },
    });

    if (blocking > 0) {
      throw DomainException.conflict(
        `This value is used by ${blocking} enabled rule${blocking === 1 ? '' : 's'}. ` +
          `Disable or delete ${blocking === 1 ? 'that rule' : 'those rules'} first.`,
      );
    }
  }
}

/** Live ids matching a condition. */
async function liveIds<T extends { id: string }>(
  manager: EntityManager,
  entity: new () => T,
  where: Record<string, unknown>,
): Promise<string[]> {
  const rows = await manager.find(entity, {
    where: { ...where, deletedAt: LIVE_SENTINEL_SQL } as never,
    select: { id: true } as never,
  });

  return rows.map((row) => row.id);
}

/**
 * Mark rows deleted, in one statement.
 *
 * The timestamp is the caller's, so every row a single delete touches carries
 * the same instant — which is what makes "everything removed by that action"
 * answerable later.
 */
async function softDelete<T>(
  manager: EntityManager,
  entity: new () => T,
  ids: string[],
  deletedAt: Date,
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const result = await manager.update(entity, { id: In(ids) } as never, {
    deletedAt,
  } as never);

  return result.affected ?? 0;
}

/**
 * Disable rules whose target has gone, recording why.
 *
 * **Disabled, not deleted.** A rule is work the merchant did; deleting it
 * because a target vanished throws that away silently. `disabledReason` is what
 * lets the dashboard say *why* rather than showing a rule that mysteriously
 * stopped working — the difference between "surfaced to the merchant" as a
 * promise and as a feature.
 *
 * Already-disabled rules are left alone: overwriting the reason on a rule the
 * merchant turned off themselves would misreport who did it.
 */
async function disableRulesTargeting(
  manager: EntityManager,
  targets: ReadonlyArray<{ type: RuleTargetType; ids: string[] }>,
): Promise<number> {
  let disabled = 0;

  for (const target of targets) {
    if (target.ids.length === 0) {
      continue;
    }

    const result = await manager.update(
      OptionRule,
      {
        targetType: target.type,
        targetId: In(target.ids),
        isEnabled: true,
        deletedAt: LIVE_SENTINEL_SQL,
      } as never,
      { isEnabled: false, disabledReason: RuleDisabledReason.TARGET_DELETED } as never,
    );

    disabled += result.affected ?? 0;
  }

  return disabled;
}
