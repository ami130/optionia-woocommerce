import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { GroupDisplayType } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
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
    const created = await this.groups.create(optionSetId, {
      optionSetId,
      label: input.label.trim(),
      description: input.description ?? null,
      displayType: input.displayType ?? GroupDisplayType.INLINE,
      isCollapsible: input.isCollapsible ?? false,
      isEnabled: input.isEnabled ?? true,
      sortOrder: await this.groups.nextSortOrder(optionSetId),
    } as never);

    await this.touchSet(optionSetId);
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
    await this.touchSet(before.optionSetId);

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

    await this.groups.update({ id } as never, { deletedAt: new Date() } as never);
    await this.touchSet(before.optionSetId);

    await this.audit.record({
      action: AuditAction.OPTION_GROUP_DELETED,
      resourceType: 'option_group',
      resourceId: id,
      changes: diff({ label: before.label, deleted: false }, { label: before.label, deleted: true }),
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

    await this.touchSet(source.optionSetId);
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

    await this.touchSet(optionSetId);
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

  /** Confirm the set exists and belongs to this tenant, as a 404 either way. */
  private async assertSetExists(optionSetId: string): Promise<void> {
    if (!(await this.sets.findById(optionSetId))) {
      throw DomainException.notFound('Option set');
    }
  }

  /**
   * Advance the parent set's `rowVersion`.
   *
   * A group, option or value is part of its set, so editing one *is* editing the
   * set. Without this, two people could edit different groups of one set and
   * neither would see a conflict — which is precisely the silent overwrite
   * M7.4b exists to prevent, arriving one level down where nobody looked.
   */
  private async touchSet(optionSetId: string): Promise<void> {
    await this.sets.applyChange(optionSetId, {});
  }
}

/**
 * Copy a group's options and values into another group.
 *
 * Shared by group duplication and, later, set duplication — the traversal is the
 * same and having it in one place is what keeps the two from drifting.
 */
export async function copyOptionsInto(
  manager: EntityManager,
  fromGroupId: string,
  toGroupId: string,
): Promise<void> {
  const options = await manager.find(Option, {
    where: { optionGroupId: fromGroupId, deletedAt: LIVE_SENTINEL_SQL as never },
    order: { sortOrder: 'ASC' },
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

    const values = await manager.find(OptionValue, {
      where: { optionId: option.id, deletedAt: LIVE_SENTINEL_SQL as never },
      order: { sortOrder: 'ASC' },
    });

    if (values.length > 0) {
      await manager.save(
        values.map((value) =>
          manager.create(OptionValue, {
            optionId: optionCopy.id,
            valueKey: value.valueKey,
            label: value.label,
            sortOrder: value.sortOrder,
            priceType: value.priceType,
            priceAmountMinor: value.priceAmountMinor,
            priceConfig: value.priceConfig,
            imageUrl: value.imageUrl,
            colorHex: value.colorHex,
            skuSuffix: value.skuSuffix,
            weightDeltaGrams: value.weightDeltaGrams,
            isDefault: value.isDefault,
            isEnabled: value.isEnabled,
          }),
        ),
      );
    }
  }
}

/**
 * The subset of `changes` that differs from what is stored.
 *
 * An unchanged field is not a change: including it would burn a `rowVersion`
 * and write an audit entry for a save that altered nothing.
 */
export function buildPatch<T extends object>(before: T, changes: Partial<T>): Partial<T> {
  const patch: Partial<T> = {};

  (Object.keys(changes) as Array<keyof T>).forEach((field) => {
    const next = changes[field];

    if (next === undefined) {
      return;
    }

    const value = typeof next === 'string' ? (next.trim() as T[keyof T]) : next;

    if (value !== before[field]) {
      patch[field] = value;
    }
  });

  return patch;
}

/** The named fields of an object, for diffing against a patch. */
export function pick<T extends object>(source: T, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, source[field as keyof T]]));
}
