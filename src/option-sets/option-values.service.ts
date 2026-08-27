import { Injectable } from '@nestjs/common';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PriceType } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionValue } from './entities/option-value.entity';
import { buildPatch, pick } from './entity-patch';
import { ParentSetService } from './parent-set';
import { CascadeService } from './cascade.service';
import { OptionValuesRepository } from './option-values.repository';
import { OptionsRepository } from './options.repository';
import { OptionTypeValidator } from './types/option-type.validator';

/** What a caller may change on a value. */
export interface ValueChanges {
  label?: string;
  priceType?: PriceType;
  priceAmountMinor?: number;
  priceConfig?: Record<string, unknown> | null;
  imageUrl?: string | null;
  colorHex?: string | null;
  skuSuffix?: string | null;
  weightDeltaGrams?: number | null;
  isDefault?: boolean;
  isEnabled?: boolean;
}

export interface CreateValueInput extends ValueChanges {
  valueKey: string;
  label: string;
}

/**
 * Value lifecycle (M7.2).
 *
 * Values are where a choice option's money lives, so this is the second half of
 * M7.3's acceptance: `price_config` is validated here against the same Zod
 * schema the evaluator will read.
 */
@Injectable()
export class OptionValuesService {
  constructor(
    private readonly values: OptionValuesRepository,
    private readonly options: OptionsRepository,
    private readonly audit: AuditService,
    private readonly validator: OptionTypeValidator,
    private readonly cascade: CascadeService,
    private readonly parents: ParentSetService,
  ) {}

  async findOne(id: string): Promise<OptionValue> {
    const value = await this.values.findById(id);

    if (!value) {
      throw DomainException.notFound('Option value');
    }

    return value;
  }

  async listByOption(optionId: string): Promise<OptionValue[]> {
    await this.assertOptionExists(optionId);

    return this.values.listByOption(optionId);
  }

  async create(optionId: string, input: CreateValueInput): Promise<OptionValue> {
    await this.assertOptionExists(optionId);
    assertWithinLimit(
      await this.values.count({ where: { optionId } } as never),
      AUTHORING_LIMITS.valuesPerOption,
      'values',
    );
    const valueKey = input.valueKey.trim();

    if (input.priceConfig !== undefined && input.priceConfig !== null) {
      this.validator.assertValidValuePricing(input.priceConfig);
    }

    await this.assertValueKeyAvailable(optionId, valueKey);

    const created = await this.values.create(optionId, {
      optionId,
      valueKey,
      label: input.label.trim(),
      priceType: input.priceType ?? PriceType.FIXED,
      priceAmountMinor: input.priceAmountMinor ?? 0,
      priceConfig: input.priceConfig ?? null,
      imageUrl: input.imageUrl ?? null,
      colorHex: input.colorHex ?? null,
      skuSuffix: input.skuSuffix ?? null,
      weightDeltaGrams: input.weightDeltaGrams ?? null,
      isDefault: input.isDefault ?? false,
      isEnabled: input.isEnabled ?? true,
      sortOrder: await this.values.nextSortOrder(optionId),
    } as never);

    if (created.isDefault) {
      await this.clearOtherDefaults(optionId, created.id);
    }

    await this.parents.touchForValue(optionId);
    await this.audit.record({
      action: AuditAction.OPTION_VALUE_CREATED,
      resourceType: 'option_value',
      resourceId: created.id,
      changes: diff(null, { valueKey: created.valueKey, label: created.label }),
    });

    return created;
  }

  async update(id: string, changes: ValueChanges): Promise<OptionValue> {
    const before = await this.findOne(id);
    const patch = buildPatch(before, changes as Partial<OptionValue>);

    if (Object.keys(patch).length === 0) {
      return before;
    }

    if ('priceConfig' in patch && patch.priceConfig !== null) {
      this.validator.assertValidValuePricing(patch.priceConfig);
    }

    await this.values.update({ id } as never, patch as never);

    if (patch.isDefault === true) {
      await this.clearOtherDefaults(before.optionId, id);
    }

    await this.parents.touchForValue(before.optionId);
    await this.audit.record({
      action: AuditAction.OPTION_VALUE_UPDATED,
      resourceType: 'option_value',
      resourceId: id,
      changes: diff(pick(before, Object.keys(patch)), patch),
    });

    return this.findOne(id);
  }

  /**
   * Soft delete a value.
   *
   * **Blocked when an enabled rule targets it** — the one rule in M7.2's cascade
   * table that refuses rather than cascades. Silently disabling the rule instead
   * would change what a storefront shows without telling anyone: a rule saying
   * "hide shipping when Gift Wrap is chosen" simply stops hiding it, and the
   * merchant learns that from a customer.
   */
  async remove(id: string): Promise<void> {
    const before = await this.findOne(id);

    try {
      await this.cascade.assertValueIsNotRuleTarget(id);
    } catch (error) {
      /**
       * Record the refusal, then re-raise.
       *
       * M7.6 asks for a trail of mutations, and this is not one — nothing
       * changed. It is recorded anyway because "the merchant tried to delete a
       * value a live rule depends on" is exactly the event support is asked
       * about, and an empty trail makes that question unanswerable.
       */
      await this.audit.record({
        action: AuditAction.OPTION_VALUE_DELETE_REFUSED,
        resourceType: 'option_value',
        resourceId: id,
        changes: { valueKey: { from: before.valueKey, to: before.valueKey } },
      });

      throw error;
    }

    await this.values.update({ id } as never, { deletedAt: new Date() } as never);
    await this.parents.touchForValue(before.optionId);

    await this.audit.record({
      action: AuditAction.OPTION_VALUE_DELETED,
      resourceType: 'option_value',
      resourceId: id,
      changes: diff(
        { valueKey: before.valueKey, deleted: false },
        { valueKey: before.valueKey, deleted: true },
      ),
    });
  }

  /**
   * Copy a value within its option (M7.2).
   *
   * The lifecycle table says the operation set is *"inherited by groups,
   * options, and values alike"*, and duplicate was built for the first two and
   * not the third — a merchant configuring twelve near-identical colour swatches
   * had to type each one.
   *
   * The copy needs a new `valueKey`: it lands on the same option, where
   * `uq_option_values_option_key` forbids a repeat.
   *
   * **Never the default.** Two defaults on one option is a state the storefront
   * cannot render, and a copy silently claiming the default would change which
   * value is pre-selected.
   */
  async duplicate(id: string, valueKey?: string): Promise<OptionValue> {
    const source = await this.findOne(id);

    assertWithinLimit(
      await this.values.count({ where: { optionId: source.optionId } } as never),
      AUTHORING_LIMITS.valuesPerOption,
      'values',
    );

    const newKey = valueKey?.trim() || (await this.availableCopyKey(source.optionId, source.valueKey));

    await this.assertValueKeyAvailable(source.optionId, newKey);

    const created = await this.values.create(source.optionId, {
      optionId: source.optionId,
      valueKey: newKey,
      label: `${source.label} (copy)`,
      sortOrder: await this.values.nextSortOrder(source.optionId),
      priceType: source.priceType,
      priceAmountMinor: source.priceAmountMinor,
      priceConfig: source.priceConfig,
      imageUrl: source.imageUrl,
      colorHex: source.colorHex,
      skuSuffix: source.skuSuffix,
      weightDeltaGrams: source.weightDeltaGrams,
      isDefault: false,
      // Disabled work stays disabled, as everywhere else.
      isEnabled: source.isEnabled,
    } as never);

    await this.parents.touchForValue(source.optionId);
    await this.audit.record({
      action: AuditAction.OPTION_VALUE_DUPLICATED,
      resourceType: 'option_value',
      resourceId: created.id,
      changes: { ...diff(null, { valueKey: created.valueKey, label: created.label }), copiedFrom: source.id },
    });

    return created;
  }

  /**
   * A free key of the form `key-copy`, `key-copy-2`, …
   *
   * Bounded rather than looping forever: an unbounded loop against a unique
   * constraint is a hang waiting to happen.
   */
  private async availableCopyKey(optionId: string, valueKey: string): Promise<string> {
    for (let attempt = 1; attempt <= COPY_KEY_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 1 ? `${valueKey}-copy` : `${valueKey}-copy-${attempt}`;

      if (
        candidate.length <= VALUE_KEY_MAX_LENGTH &&
        !(await this.values.valueKeyExists(optionId, candidate))
      ) {
        return candidate;
      }
    }

    throw DomainException.conflict(
      'Could not generate a free key for the copy. Supply one explicitly.',
    );
  }

  /**
   * Reorder an option's values in one request (M7.2).
   *
   * The order values appear in is what a customer reads — "Small, Medium,
   * Large" rather than the order the merchant happened to type them.
   */
  async reorder(
    optionId: string,
    entries: ReadonlyArray<{ id: string; sortOrder: number }>,
  ): Promise<OptionValue[]> {
    await this.assertOptionExists(optionId);

    const siblings = await this.values.listByOption(optionId);
    const known = new Set(siblings.map((value) => value.id));
    const unknown = entries.filter((entry) => !known.has(entry.id));

    if (unknown.length > 0) {
      throw DomainException.validation(
        unknown.map((entry, index) => ({
          field: `values.${index}.id`,
          code: 'NOT_IN_OPTION',
          params: { message: `Value ${entry.id} does not belong to this option.` },
        })),
      );
    }

    for (const entry of entries) {
      await this.values.update({ id: entry.id } as never, {
        sortOrder: entry.sortOrder,
      } as never);
    }

    await this.parents.touchForValue(optionId);
    await this.audit.record({
      action: AuditAction.OPTION_REORDERED,
      resourceType: 'option',
      resourceId: optionId,
      changes: {
        values: {
          from: siblings.map((value) => ({ id: value.id, sortOrder: value.sortOrder })),
          to: entries.map((entry) => ({ id: entry.id, sortOrder: entry.sortOrder })),
        },
      },
    });

    return this.values.listByOption(optionId);
  }

  /**
   * Exactly one default per option.
   *
   * Two defaults on one option is not a state the storefront can render — it
   * would pre-select two mutually exclusive choices on a `radio`. Enforced in
   * code rather than by a constraint because "at most one true per parent" is
   * not expressible as a unique index over a boolean.
   *
   * The write is a single statement (`makeSoleDefault`) rather than a read
   * followed by per-sibling updates: concurrent creates race that pattern into
   * leaving **zero** defaults.
   */
  private async clearOtherDefaults(optionId: string, keepId: string): Promise<void> {
    await this.values.makeSoleDefault(optionId, keepId);
  }

  private async assertValueKeyAvailable(optionId: string, valueKey: string): Promise<void> {
    if (await this.values.valueKeyExists(optionId, valueKey)) {
      throw DomainException.validation([
        {
          field: 'valueKey',
          code: 'DUPLICATE_KEY',
          params: { message: `A value with key "${valueKey}" already exists on this option.` },
        },
      ]);
    }
  }

  private async assertOptionExists(optionId: string): Promise<void> {
    if (!(await this.options.findById(optionId))) {
      throw DomainException.notFound('Option');
    }
  }

}

/** Bounded so a unique-constraint collision cannot become an infinite loop. */
const COPY_KEY_ATTEMPTS = 50;

/** Matches `option_values.value_key`. */
const VALUE_KEY_MAX_LENGTH = 64;
