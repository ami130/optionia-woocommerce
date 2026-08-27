import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { Cardinality, Presentation, ValueKind } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
import { buildPatch, pick } from './entity-patch';
import { ParentSetService } from './parent-set';
import { AlreadyDeletedError, CascadeService } from './cascade.service';
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionsRepository } from './options.repository';
import { OptionTypeValidator } from './types/option-type.validator';

/** What a caller may change on an option. */
export interface OptionChanges {
  label?: string;
  description?: string | null;
  placeholder?: string | null;
  helpText?: string | null;
  isRequired?: boolean;
  isEnabled?: boolean;
  defaultValue?: string | null;
  validation?: Record<string, unknown> | null;
  pricing?: Record<string, unknown> | null;
  display?: Record<string, unknown> | null;
}

export interface CreateOptionInput extends OptionChanges {
  key: string;
  label: string;
  presentation: Presentation;
  valueKind?: ValueKind;
  cardinality?: Cardinality;
}

/**
 * Option lifecycle (M7.2), and the first caller of the type registry (M7.3).
 *
 * **This is where M7.3's acceptance is met.** The registry and its Zod schemas
 * were built in 7d and had no caller until now — options are the level that
 * carries `validation`, `pricing` and `display` JSON, so this is the API
 * boundary at which a malformed pricing config is rejected.
 */
@Injectable()
export class OptionsService {
  constructor(
    private readonly options: OptionsRepository,
    private readonly groups: OptionGroupsRepository,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly validator: OptionTypeValidator,
    private readonly cascade: CascadeService,
    private readonly parents: ParentSetService,
  ) {}

  async findOne(id: string): Promise<Option> {
    const option = await this.options.findById(id);

    if (!option) {
      throw DomainException.notFound('Option');
    }

    return option;
  }

  async listByGroup(optionGroupId: string): Promise<Option[]> {
    await this.assertGroupExists(optionGroupId);

    return this.options.listByGroup(optionGroupId);
  }

  /**
   * Append an option to a group.
   *
   * The three axes come from the registry rather than the caller when they are
   * not supplied: `radio` *is* `choice`/`one`, and letting a client assert
   * otherwise would store a row the evaluator cannot interpret. When they are
   * supplied, the validator checks they agree with the type's declaration.
   */
  async create(optionGroupId: string, input: CreateOptionInput): Promise<Option> {
    const group = await this.assertGroupExists(optionGroupId);
    await this.assertRoomForOption(optionGroupId);
    const key = input.key.trim();

    this.validator.assertValidOption(input.presentation, {
      valueKind: input.valueKind,
      cardinality: input.cardinality,
      validation: input.validation,
      pricing: input.pricing,
      display: input.display,
    });

    await this.assertKeyAvailable(optionGroupId, key);

    const definition = this.validator.describe(input.presentation);

    const created = await this.options.create(optionGroupId, {
      optionGroupId,
      key,
      valueKind: input.valueKind ?? definition.valueKind,
      cardinality: input.cardinality ?? definition.cardinality[0],
      presentation: input.presentation,
      label: input.label.trim(),
      description: input.description ?? null,
      placeholder: input.placeholder ?? null,
      helpText: input.helpText ?? null,
      isRequired: input.isRequired ?? false,
      isEnabled: input.isEnabled ?? true,
      defaultValue: input.defaultValue ?? null,
      validation: input.validation ?? null,
      pricing: input.pricing ?? null,
      display: input.display ?? null,
      sortOrder: await this.options.nextSortOrder(optionGroupId),
    } as never);

    await this.parents.touchSet(group.optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_CREATED,
      resourceType: 'option',
      resourceId: created.id,
      changes: diff(null, { key: created.key, label: created.label, presentation: created.presentation }),
    });

    return created;
  }

  /**
   * Patch an option.
   *
   * `key` is absent from `OptionChanges` deliberately. M7.2 makes it immutable
   * after first publish because order meta stores `option_key`, and a key that
   * can change makes every historic order unreadable. Until publish exists
   * ([7i]) there is no "after first publish" to test against, so the safe
   * reading is the one that cannot corrupt an order: it is not editable here.
   */
  async update(id: string, changes: OptionChanges): Promise<Option> {
    const before = await this.findOne(id);
    const patch = buildPatch(before, changes as Partial<Option>);

    if (Object.keys(patch).length === 0) {
      return before;
    }

    // Re-validate against the *merged* result, not the patch alone: a partial
    // update can produce a combination that is invalid even though each field
    // looked fine on its own.
    this.validator.assertValidOption(before.presentation, {
      valueKind: before.valueKind,
      cardinality: before.cardinality,
      validation: 'validation' in patch ? patch.validation : before.validation,
      pricing: 'pricing' in patch ? patch.pricing : before.pricing,
      display: 'display' in patch ? patch.display : before.display,
    });

    await this.options.update({ id } as never, patch as never);
    await this.parents.touchForOption(before.optionGroupId);

    await this.audit.record({
      action: AuditAction.OPTION_UPDATED,
      resourceType: 'option',
      resourceId: id,
      changes: diff(pick(before, Object.keys(patch)), patch),
    });

    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const before = await this.findOne(id);
    const deletedAt = new Date();

    let cascaded;

    try {
      // Marks the option itself too, in the same transaction.
      cascaded = await this.cascade.onOptionDeleted(id, deletedAt);
    } catch (error) {
      if (error instanceof AlreadyDeletedError) {
        return;
      }

      throw error;
    }

    await this.parents.touchForOption(before.optionGroupId);

    await this.audit.record({
      action: AuditAction.OPTION_DELETED,
      resourceType: 'option',
      resourceId: id,
      changes: {
        ...diff({ key: before.key, deleted: false }, { key: before.key, deleted: true }),
        cascaded,
      },
    });
  }

  /**
   * Deep copy an option with its values.
   *
   * The copy needs a new `key`: unlike a duplicated *group*, this lands in the
   * same group as the source, where `uq_options_group_key` forbids a repeat.
   */
  async duplicate(id: string, key?: string): Promise<Option> {
    const source = await this.findOne(id);

    // A copy is a create: it must respect the same ceiling.
    await this.assertRoomForOption(source.optionGroupId);

    const newKey = key?.trim() || (await this.availableCopyKey(source.optionGroupId, source.key));

    await this.assertKeyAvailable(source.optionGroupId, newKey);

    const sortOrder = await this.options.nextSortOrder(source.optionGroupId);

    const copy = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(Option, {
          optionGroupId: source.optionGroupId,
          key: newKey,
          valueKind: source.valueKind,
          cardinality: source.cardinality,
          presentation: source.presentation,
          label: `${source.label} (copy)`,
          description: source.description,
          placeholder: source.placeholder,
          helpText: source.helpText,
          isRequired: source.isRequired,
          defaultValue: source.defaultValue,
          validation: source.validation,
          pricing: source.pricing,
          display: source.display,
          isEnabled: source.isEnabled,
          sortOrder,
        }),
      );

      const values = await manager.find(OptionValue, {
        where: { optionId: source.id, deletedAt: LIVE_SENTINEL_SQL as never },
        order: { sortOrder: 'ASC' },
      });

      if (values.length > 0) {
        await manager.save(
          values.map((value) =>
            manager.create(OptionValue, {
              optionId: created.id,
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

      return created;
    });

    await this.parents.touchForOption(source.optionGroupId);
    await this.audit.record({
      action: AuditAction.OPTION_DUPLICATED,
      resourceType: 'option',
      resourceId: copy.id,
      changes: { ...diff(null, { key: copy.key, label: copy.label }), copiedFrom: source.id },
    });

    return copy;
  }

  /**
   * A free key of the form `key-copy`, `key-copy-2`, …
   *
   * Bounded rather than looping forever: a merchant with 50 copies of one option
   * has a different problem, and an unbounded loop against a unique constraint is
   * a hang waiting to happen.
   */
  private async availableCopyKey(optionGroupId: string, key: string): Promise<string> {
    for (let attempt = 1; attempt <= COPY_KEY_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 1 ? `${key}-copy` : `${key}-copy-${attempt}`;

      if (candidate.length <= KEY_MAX_LENGTH && !(await this.options.keyExists(optionGroupId, candidate))) {
        return candidate;
      }
    }

    throw DomainException.conflict(
      'Could not generate a free key for the copy. Supply one explicitly.',
    );
  }

  /**
   * Reorder a group's options in one request (M7.2).
   *
   * The lifecycle table lists Reorder as inherited by every level, and only
   * groups had it — so a merchant could rearrange groups but not the options
   * inside one, which meant deleting and recreating them in order.
   *
   * **Every id is verified before anything is written**, for the same reason as
   * groups: a partial reorder leaves an arrangement the merchant did not ask for
   * and cannot easily undo.
   */
  async reorder(
    optionGroupId: string,
    entries: ReadonlyArray<{ id: string; sortOrder: number }>,
  ): Promise<Option[]> {
    await this.assertGroupExists(optionGroupId);

    const siblings = await this.options.listByGroup(optionGroupId);
    const known = new Set(siblings.map((option) => option.id));
    const unknown = entries.filter((entry) => !known.has(entry.id));

    if (unknown.length > 0) {
      throw DomainException.validation(
        unknown.map((entry, index) => ({
          field: `options.${index}.id`,
          code: 'NOT_IN_GROUP',
          params: { message: `Option ${entry.id} does not belong to this group.` },
        })),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const entry of entries) {
        await manager.update(Option, { id: entry.id }, { sortOrder: entry.sortOrder });
      }
    });

    await this.parents.touchForOption(optionGroupId);
    await this.audit.record({
      action: AuditAction.OPTION_GROUP_REORDERED,
      resourceType: 'option_group',
      resourceId: optionGroupId,
      changes: {
        options: {
          from: siblings.map((option) => ({ id: option.id, sortOrder: option.sortOrder })),
          to: entries.map((entry) => ({ id: entry.id, sortOrder: entry.sortOrder })),
        },
      },
    });

    return this.options.listByGroup(optionGroupId);
  }

  /** Refuse a create that would exceed the structural ceiling. */
  private async assertRoomForOption(optionGroupId: string): Promise<void> {
    assertWithinLimit(
      await this.options.count({ where: { optionGroupId } } as never),
      AUTHORING_LIMITS.optionsPerGroup,
      'options',
    );
  }

  private async assertKeyAvailable(optionGroupId: string, key: string): Promise<void> {
    if (await this.options.keyExists(optionGroupId, key)) {
      throw DomainException.validation([
        {
          field: 'key',
          code: 'DUPLICATE_KEY',
          params: { message: `An option with key "${key}" already exists in this group.` },
        },
      ]);
    }
  }

  private async assertGroupExists(optionGroupId: string): Promise<{ optionSetId: string }> {
    const group = await this.groups.findById(optionGroupId);

    if (!group) {
      throw DomainException.notFound('Option group');
    }

    return group;
  }

}

/** Bounded so a unique-constraint collision cannot become an infinite loop. */
const COPY_KEY_ATTEMPTS = 50;

/** Matches `options.key`. */
const KEY_MAX_LENGTH = 64;
