import { Injectable } from '@nestjs/common';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PriceType } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionValue } from './entities/option-value.entity';
import { buildPatch, pick } from './option-groups.service';
import { CascadeService } from './cascade.service';
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionSetsRepository } from './option-sets.repository';
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
    private readonly groups: OptionGroupsRepository,
    private readonly sets: OptionSetsRepository,
    private readonly audit: AuditService,
    private readonly validator: OptionTypeValidator,
    private readonly cascade: CascadeService,
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

    await this.touchSetForValue(optionId);
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

    await this.touchSetForValue(before.optionId);
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

    await this.cascade.assertValueIsNotRuleTarget(id);

    await this.values.update({ id } as never, { deletedAt: new Date() } as never);
    await this.touchSetForValue(before.optionId);

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

  /** See `OptionGroupsService.touchSet` — a child edit is an edit to its set. */
  private async touchSetForValue(optionId: string): Promise<void> {
    const option = await this.options.findById(optionId);

    if (!option) {
      return;
    }

    const group = await this.groups.findById(option.optionGroupId);

    if (group) {
      await this.sets.applyChange(group.optionSetId, {});
    }
  }
}
