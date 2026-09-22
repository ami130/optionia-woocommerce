import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { buildPatch, pick } from './entity-patch';
import { ParentSetService } from './parent-set';
import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { GroupDisplayType, RuleDisabledReason } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionRule } from './entities/option-rule.entity';
import { OptionValue } from './entities/option-value.entity';
import { PresentationalItem } from './entities/presentational-item.entity';
import { copyableItemFields, copyableRuleFields, copyableValueFields } from './duplication';
import { Option } from './entities/option.entity';
import { AlreadyDeletedError, CascadeService } from './cascade.service';
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionSetsRepository } from './option-sets.repository';

/** What a caller may change on a group. */
export interface GroupChanges {
  label?: string;
  description?: string | null;
  displayType?: GroupDisplayType;
  isCollapsible?: boolean;
  isEnabled?: boolean;
}

/**
 * Group lifecycle (M7.2).
 *
 * The operation set defined in M7.2 — create, rename, update, enable/disable,
 * duplicate, delete — applied to groups. Options and values apply the same set,
 * which is why the shape of these three services is deliberately identical.
 */
@Injectable()
export class OptionGroupsService {
  constructor(
    private readonly groups: OptionGroupsRepository,
    private readonly sets: OptionSetsRepository,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly cascade: CascadeService,
    private readonly parents: ParentSetService,
  ) {}

  async findOne(id: string): Promise<OptionGroup> {
    const group = await this.groups.findById(id);

    if (!group) {
      throw DomainException.notFound('Option group');
    }

    return group;
  }

  async listBySet(optionSetId: string): Promise<OptionGroup[]> {
    await this.assertSetExists(optionSetId);

    return this.groups.listBySet(optionSetId);
  }

  /**
   * Append a group to a set.
   *
   * The parent is verified by the repository before the insert — an insert has
   * no row to join from, so it is the one operation where scoping cannot be a
   * predicate on the write itself.
   */
  async create(optionSetId: string, input: GroupChanges & { label: string }): Promise<OptionGroup> {
    await this.assertRoomForGroup(optionSetId);

    const created = await this.groups.create(optionSetId, {
      optionSetId,
      label: input.label.trim(),
      description: input.description ?? null,
      displayType: input.displayType ?? GroupDisplayType.INLINE,
      isCollapsible: input.isCollapsible ?? false,
      isEnabled: input.isEnabled ?? true,
      sortOrder: await this.groups.nextSortOrder(optionSetId),
    } as never);

    await this.parents.touchSet(optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_GROUP_CREATED,
      resourceType: 'option_group',
      resourceId: created.id,
      changes: diff(null, { label: created.label, optionSetId }),
    });

    return created;
  }

  async update(id: string, changes: GroupChanges): Promise<OptionGroup> {
    const before = await this.findOne(id);
    const patch = buildPatch(before, changes);

    if (Object.keys(patch).length === 0) {
      return before;
    }

    await this.groups.update({ id } as never, patch as never);
    await this.parents.touchSet(before.optionSetId);

    await this.audit.record({
      action: AuditAction.OPTION_GROUP_UPDATED,
      resourceType: 'option_group',
      resourceId: id,
      changes: diff(pick(before, Object.keys(patch)), patch),
    });

    return this.findOne(id);
  }

  /**
   * Soft delete a group.
   *
   * Its options and values are **not** touched here: the read chain already
   * excludes children of a deleted parent at every join, so they disappear from
   * every query without a cascading write. 7g makes that cascade explicit for
   * the cases the join cannot express — rules pointing at a deleted target.
   */
  async remove(id: string): Promise<void> {
    const before = await this.findOne(id);
    const deletedAt = new Date();

    let cascaded;

    try {
      // Marks the group itself too, in the same transaction.
      cascaded = await this.cascade.onGroupDeleted(id, deletedAt);
    } catch (error) {
      if (error instanceof AlreadyDeletedError) {
        return;
      }

      throw error;
    }

    await this.parents.touchSet(before.optionSetId);

    await this.audit.record({
      action: AuditAction.OPTION_GROUP_DELETED,
      resourceType: 'option_group',
      resourceId: id,
      changes: {
        ...diff({ label: before.label, deleted: false }, { label: before.label, deleted: true }),
        cascaded,
      },
    });
  }

  /**
   * Deep copy a group with its options and values.
   *
   * **One transaction**, for the reason M7.1's duplicate gives: a half-copied
   * group looks finished and is missing values nobody notices until a customer
   * cannot pick one.
   */
  async duplicate(id: string, label?: string): Promise<OptionGroup> {
    const source = await this.findOne(id);

    // A copy is a create: it must respect the same ceiling.
    await this.assertRoomForGroup(source.optionSetId);

    const sortOrder = await this.groups.nextSortOrder(source.optionSetId);

    const copy = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(OptionGroup, {
          optionSetId: source.optionSetId,
          label: label?.trim() || `${source.label} (copy)`,
          description: source.description,
          displayType: source.displayType,
          isCollapsible: source.isCollapsible,
          // Disabled work stays disabled: a copy that silently re-enables it
          // would republish it on the next publish.
          isEnabled: source.isEnabled,
          sortOrder,
        }),
      );

      await copyOptionsInto(manager, source.id, created.id);

      return created;
    });

    await this.parents.touchSet(source.optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_GROUP_DUPLICATED,
      resourceType: 'option_group',
      resourceId: copy.id,
      changes: { ...diff(null, { label: copy.label }), copiedFrom: source.id },
    });

    return copy;
  }

  /**
   * Reorder a set's groups in one request.
   *
   * Gap-tolerant integers, so moving one group between two others is a single
   * write rather than renumbering every sibling — the reason M7.2 asks for a
   * bulk endpoint at all.
   *
   * **Every id is verified before anything is written.** A partial reorder
   * leaves the set in an order the merchant did not ask for and cannot easily
   * undo, so an unknown id fails the whole request.
   */
  async reorder(optionSetId: string, entries: ReadonlyArray<{ id: string; sortOrder: number }>): Promise<OptionGroup[]> {
    await this.assertSetExists(optionSetId);

    const siblings = await this.groups.listBySet(optionSetId);
    const known = new Set(siblings.map((group) => group.id));
    const unknown = entries.filter((entry) => !known.has(entry.id));

    if (unknown.length > 0) {
      throw DomainException.validation(
        unknown.map((entry, index) => ({
          field: `groups.${index}.id`,
          code: 'NOT_IN_SET',
          params: { message: `Group ${entry.id} does not belong to this option set.` },
        })),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const entry of entries) {
        await manager.update(OptionGroup, { id: entry.id }, { sortOrder: entry.sortOrder });
      }
    });

    await this.parents.touchSet(optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_SET_REORDERED,
      resourceType: 'option_set',
      resourceId: optionSetId,
      changes: {
        groups: {
          from: siblings.map((group) => ({ id: group.id, sortOrder: group.sortOrder })),
          to: entries.map((entry) => ({ id: entry.id, sortOrder: entry.sortOrder })),
        },
      },
    });

    return this.groups.listBySet(optionSetId);
  }

  /** Refuse a create that would exceed the structural ceiling. */
  private async assertRoomForGroup(optionSetId: string): Promise<void> {
    assertWithinLimit(
      await this.groups.count({ where: { optionSetId } } as never),
      AUTHORING_LIMITS.groupsPerSet,
      'groups',
    );
  }

  /** Confirm the set exists and belongs to this tenant, as a 404 either way. */
  private async assertSetExists(optionSetId: string): Promise<void> {
    if (!(await this.sets.findById(optionSetId))) {
      throw DomainException.notFound('Option set');
    }
  }

}

/**
 * Copy a group's children — options, their values, and presentational items.
 *
 * 🔴 **"Later" arrived and the drift had already happened.** This said it was
 * shared by group *and* set duplication; the set path had re-implemented the same
 * traversal beside it, and the two diverged exactly as predicted — `groupLabel`
 * reached neither, and presentational items reached no copy path at all. A
 * merchant duplicating a set lost every heading and every `<optgroup>`, silently.
 *
 * `OptionSetsService.duplicate` now calls this rather than repeating it, so there
 * is one traversal again, and the per-row field lists live in `duplication.ts`.
 *
 * ## Why it returns an id map
 *
 * 🔴 **Rules point at rows by id, and a copy has new ids.** An `OptionRule`
 * targets a group, option or value, and its conditions name options — all in the
 * *source* set. Copying a rule verbatim aims it at another set's rows, which is
 * worse than dropping it: it would silently govern the wrong document.
 *
 * Only this traversal knows which new row replaced which old one, so it reports
 * that rather than making the caller re-derive it — a second traversal is how
 * `groupLabel` and the presentational items were lost in the first place.
 */
export async function copyOptionsInto(
  manager: EntityManager,
  fromGroupId: string,
  toGroupId: string,
): Promise<Map<string, string>> {
  const options = await manager.find(Option, {
    where: { optionGroupId: fromGroupId, deletedAt: LIVE_SENTINEL_SQL as never },
    order: { sortOrder: 'ASC' },
  });

  /** Source row id -> copied row id, for options and values alike. */
  const idMap = new Map<string, string>();

  if (options.length === 0) {
    return idMap;
  }

  /**
   * Every value for every option, in one query.
   *
   * Querying per option made copying an N-option group cost N+1 round trips
   * inside a transaction holding row locks. One `IN` and a group-by is the same
   * result at constant cost.
   */
  const values = await manager.find(OptionValue, {
    where: {
      optionId: In(options.map((option) => option.id)),
      deletedAt: LIVE_SENTINEL_SQL as never,
    },
    order: { sortOrder: 'ASC' },
  });

  const valuesByOption = new Map<string, OptionValue[]>();

  values.forEach((value) => {
    const bucket = valuesByOption.get(value.optionId);

    if (bucket) {
      bucket.push(value);
    } else {
      valuesByOption.set(value.optionId, [value]);
    }
  });

  for (const option of options) {
    const optionCopy = await manager.save(
      manager.create(Option, {
        optionGroupId: toGroupId,
        // The key is unique per *group* and this is a new group, so it is copied
        // rather than regenerated: a merchant expects the copy to match, and a
        // mangled key would show in the config document the plugin reads.
        key: option.key,
        valueKind: option.valueKind,
        cardinality: option.cardinality,
        presentation: option.presentation,
        label: option.label,
        description: option.description,
        placeholder: option.placeholder,
        helpText: option.helpText,
        isRequired: option.isRequired,
        sortOrder: option.sortOrder,
        defaultValue: option.defaultValue,
        validation: option.validation,
        pricing: option.pricing,
        display: option.display,
        isEnabled: option.isEnabled,
      }),
    );

    idMap.set(option.id, optionCopy.id);

    const optionValues = valuesByOption.get(option.id) ?? [];

    if (optionValues.length > 0) {
      const copies = await manager.save(
        optionValues.map((value) =>
          manager.create(OptionValue, {
            optionId: optionCopy.id,
            valueKey: value.valueKey,
            label: value.label,
            sortOrder: value.sortOrder,
            // A copy in a new option keeps its default; there is no sibling to
            // collide with.
            isDefault: value.isDefault,
            ...copyableValueFields(value),
          }),
        ),
      );

      /*
       * `manager.save` preserves input order, so index alignment is safe here —
       * and it is asserted rather than trusted, because a silent misalignment
       * would remap a rule onto the wrong value.
       */
      optionValues.forEach((value, index) => {
        const copy = copies[index];

        if (copy) {
          idMap.set(value.id, copy.id);
        }
      });
    }
  }

  /*
   * Presentational items, which no copy path carried before.
   *
   * ⚠️ `sortOrder` is inherited, never reassigned: items share the scale with
   * options, and renumbering one list alone would break the interleaving the
   * storefront renders.
   */
  const items = await manager.find(PresentationalItem, {
    where: { optionGroupId: fromGroupId, deletedAt: LIVE_SENTINEL_SQL as never },
    order: { sortOrder: 'ASC' },
  });

  if (items.length > 0) {
    await manager.save(
      items.map((item) =>
        manager.create(PresentationalItem, {
          optionGroupId: toGroupId,
          ...copyableItemFields(item),
        }),
      ),
    );
  }

  return idMap;
}

/**
 * Copy an option set's rules, remapping every id they point at.
 *
 * 🔴 **`duplicate()` copied no rules at all** until Stage 17-1's audit. A
 * merchant duplicating a configured set got one with every piece of its
 * conditional logic silently removed — the third instance of this exact bug in
 * this traversal, after `groupLabel` and the presentational items.
 *
 * ## Why a rule can be dropped, and why that is the safe direction
 *
 * A rule names rows by id: `targetId` points at a group, option or value, and
 * every condition names an option. All of them are ids **in the source set**,
 * and the copy created new rows. Three outcomes are possible per rule, and only
 * one of them is acceptable:
 *
 * | If | Then |
 * |---|---|
 * | every id maps | copy the rule with the new ids |
 * | some id does not map | **skip the rule entirely** |
 * | copy the ids verbatim | ❌ a rule governing another set's rows |
 *
 * The third is worse than dropping, because it produces a rule that *works* and
 * governs the wrong document. An id fails to map when its target was
 * soft-deleted — the copy walks live rows only — which is exactly the case
 * `disabledReason: TARGET_DELETED` already describes for the source.
 *
 * ⚠️ **A skipped rule is not silent.** It is copied disabled with that reason,
 * so the merchant sees it in the copy and can repoint it, rather than
 * discovering months later that a field never hides. Dropping the row would
 * repeat the bug this function exists to fix, one level down.
 */
export async function copyRulesInto(
  manager: EntityManager,
  fromSetId: string,
  toSetId: string,
  idMap: ReadonlyMap<string, string>,
): Promise<void> {
  const rules = await manager.find(OptionRule, {
    where: { optionSetId: fromSetId, deletedAt: LIVE_SENTINEL_SQL as never },
    order: { sortOrder: 'ASC' },
  });

  if (rules.length === 0) {
    return;
  }

  await manager.save(
    rules.map((rule) => {
      const remapped = remapConditions(rule.conditions, idMap);
      const target = idMap.get(rule.targetId);
      const intact = target !== undefined && remapped !== null;

      return manager.create(OptionRule, {
        optionSetId: toSetId,
        /*
         * A rule whose target did not survive keeps the source's id rather than
         * inventing one: it is disabled, and the original id is what tells a
         * merchant *which* target went missing.
         */
        targetId: target ?? rule.targetId,
        conditions: remapped ?? rule.conditions,
        ...copyableRuleFields(rule),
        isEnabled: intact ? rule.isEnabled : false,
        disabledReason: intact ? rule.disabledReason : RuleDisabledReason.TARGET_DELETED,
      });
    }),
  );
}

/**
 * Rewrite every `optionId` inside a stored condition list through the id map.
 *
 * Returns `null` when any id has no counterpart, because a partially remapped
 * rule is the dangerous outcome — it would evaluate, against a mixture of two
 * sets' rows.
 *
 * ⚠️ **Defensive about the stored shape.** `conditions` is a `json` column, so a
 * row written by an older build, a migration, or a hand-edit may not match
 * today's schema. Anything unrecognised is treated as unmappable rather than
 * being reshaped on the way past — a copy is not the place to discover that.
 */
function remapConditions(
  conditions: unknown,
  idMap: ReadonlyMap<string, string>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(conditions)) {
    return null;
  }

  const remapped: Record<string, unknown>[] = [];

  for (const condition of conditions) {
    if (typeof condition !== 'object' || condition === null) {
      return null;
    }

    const source = condition as Record<string, unknown>;
    const optionId = source.optionId;

    if (typeof optionId !== 'string') {
      return null;
    }

    const mapped = idMap.get(optionId);

    if (mapped === undefined) {
      return null;
    }

    remapped.push({ ...source, optionId: mapped });
  }

  return remapped;
}
