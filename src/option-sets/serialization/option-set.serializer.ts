import { Injectable } from '@nestjs/common';

import { OptionGroup } from '../entities/option-group.entity';
import { OptionSet } from '../entities/option-set.entity';
import { OptionValue } from '../entities/option-value.entity';
import { Option } from '../entities/option.entity';
import { PresentationalItem } from '../entities/presentational-item.entity';
import type {
  AuthoringGroup,
  AuthoringOption,
  AuthoringOptionSet,
  AuthoringOptionValue,
  AuthoringPresentationalItem,
  PublishedGroup,
  PublishedItem,
  PublishedOption,
  PublishedOptionSet,
  PublishedValue,
} from './projections';

/** An option set with its children loaded, in display order. */
export interface OptionSetTree {
  readonly set: OptionSet;
  readonly groups: ReadonlyArray<{
    readonly group: OptionGroup;
    readonly items: readonly PresentationalItem[];
    readonly options: ReadonlyArray<{
      readonly option: Option;
      readonly values: readonly OptionValue[];
    }>;
  }>;
}

/**
 * The one serializer (M7.2b).
 *
 * ## Why every field is written out
 *
 * Nothing here spreads an entity. Each projection lists its fields explicitly,
 * so **adding a column to an entity does not silently appear in the config
 * document** — and the acceptance M7.2b asks for ("adding a field requires an
 * explicit decision about whether it appears in the published projection")
 * becomes a property of the code rather than a note in a document someone has
 * to remember.
 *
 * A spread would do the opposite: a new column would flow into the published
 * document by default, which is exactly the wrong default for data sitting on
 * merchant servers.
 *
 * ## What the published projection leaves out, and why
 *
 * - `tenantId` — the plugin has no use for it and it identifies the merchant's
 *   account, not their storefront.
 * - `rowVersion` — an optimistic lock for the dashboard; meaningless to a
 *   renderer.
 * - `createdAt` / `updatedAt` / `deletedAt` — audit fields; the document carries
 *   `generated_at` and `config_version` for freshness.
 * - `isEnabled` — a disabled thing is **absent** from the document entirely, so
 *   the flag has nothing left to say.
 * - Parent ids (`optionSetId`, `optionGroupId`, `optionId`) — the document is
 *   already a tree; a child that names its parent is the same fact twice, and
 *   two ways to disagree.
 *
 * Group and option `id` **are** included: the plugin reports analytics events
 * and order selections against them, so they are the join key between a
 * storefront and the dashboard.
 */
@Injectable()
export class OptionSetSerializer {
  /* ---------------------------------------------------------------------
   * Authoring
   * ------------------------------------------------------------------ */

  toAuthoring(tree: OptionSetTree): AuthoringOptionSet {
    const { set } = tree;

    return {
      id: set.id,
      storeId: set.storeId,
      name: set.name,
      status: set.status,
      version: set.version,
      rowVersion: set.rowVersion,
      publishedAt: iso(set.publishedAt),
      publishedConfigVersion: set.publishedConfigVersion,
      createdAt: iso(set.createdAt) as string,
      updatedAt: iso(set.updatedAt) as string,
      groups: tree.groups.map((node) => this.groupToAuthoring(node)),
    };
  }

  private groupToAuthoring(node: OptionSetTree['groups'][number]): AuthoringGroup {
    const { group } = node;

    return {
      id: group.id,
      label: group.label,
      description: group.description,
      displayType: group.displayType,
      sortOrder: group.sortOrder,
      isCollapsible: group.isCollapsible,
      isEnabled: group.isEnabled,
      createdAt: iso(group.createdAt) as string,
      updatedAt: iso(group.updatedAt) as string,
      options: node.options.map((child) => this.optionToAuthoring(child.option, child.values)),
      items: node.items.map((item) => this.itemToAuthoring(item)),
    };
  }

  private optionToAuthoring(option: Option, values: readonly OptionValue[]): AuthoringOption {
    return {
      id: option.id,
      key: option.key,
      valueKind: option.valueKind,
      cardinality: option.cardinality,
      presentation: option.presentation,
      label: option.label,
      description: option.description,
      placeholder: option.placeholder,
      helpText: option.helpText,
      isRequired: option.isRequired,
      isEnabled: option.isEnabled,
      sortOrder: option.sortOrder,
      defaultValue: option.defaultValue,
      validation: option.validation,
      pricing: option.pricing,
      display: option.display,
      createdAt: iso(option.createdAt) as string,
      updatedAt: iso(option.updatedAt) as string,
      values: values.map((value) => this.valueToAuthoring(value)),
    };
  }

  private valueToAuthoring(value: OptionValue): AuthoringOptionValue {
    return {
      id: value.id,
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
      createdAt: iso(value.createdAt) as string,
      updatedAt: iso(value.updatedAt) as string,
    };
  }

  private itemToAuthoring(item: PresentationalItem): AuthoringPresentationalItem {
    return {
      id: item.id,
      kind: item.kind,
      content: item.content,
      sortOrder: item.sortOrder,
      display: item.display,
      createdAt: iso(item.createdAt) as string,
      updatedAt: iso(item.updatedAt) as string,
    };
  }

  /* ---------------------------------------------------------------------
   * Published
   * ------------------------------------------------------------------ */

  /**
   * The config-document shape (M7.5).
   *
   * **Disabled things are dropped, not flagged.** A disabled option is work the
   * merchant kept but does not want shown, and shipping it with a flag makes
   * every consumer — renderer, evaluator, PHP and TS alike — responsible for
   * remembering to check it. One of them will forget, and the failure is an
   * option appearing on a storefront the merchant switched off.
   */
  toPublished(tree: OptionSetTree): PublishedOptionSet {
    return {
      id: tree.set.id,
      version: tree.set.version,
      groups: tree.groups
        .filter((node) => node.group.isEnabled)
        .map((node) => this.groupToPublished(node)),
    };
  }

  private groupToPublished(node: OptionSetTree['groups'][number]): PublishedGroup {
    const { group } = node;

    return {
      id: group.id,
      label: group.label,
      ...optional('description', group.description),
      display_type: group.displayType,
      sort_order: group.sortOrder,
      is_collapsible: group.isCollapsible,
      options: node.options
        .filter((child) => child.option.isEnabled)
        .map((child) => this.optionToPublished(child.option, child.values)),
      items: node.items.map((item) => this.itemToPublished(item)),
    };
  }

  private optionToPublished(option: Option, values: readonly OptionValue[]): PublishedOption {
    return {
      id: option.id,
      key: option.key,
      // `type` rather than `presentation`: the config contract names it that,
      // and the plugin is the client that cannot be redeployed easily.
      type: option.presentation,
      value_kind: option.valueKind,
      cardinality: option.cardinality,
      label: option.label,
      ...optional('description', option.description),
      ...optional('placeholder', option.placeholder),
      ...optional('help_text', option.helpText),
      is_required: option.isRequired,
      sort_order: option.sortOrder,
      ...optional('default_value', option.defaultValue),
      ...optional('validation', option.validation),
      ...optional('pricing', option.pricing),
      ...optional('display', option.display),
      values: values
        .filter((value) => value.isEnabled)
        .map((value) => this.valueToPublished(value)),
    };
  }

  /**
   * A value's price, always as a `price_config` object.
   *
   * The table carries both a `price_type` + `price_amount_minor` pair and a
   * nullable `price_config` JSON. The document carries **one** shape, because
   * two ways to express a price is two ways for the TS and PHP evaluators to
   * disagree — and M11.4 shares fixtures between them precisely to stop that.
   *
   * Money stays an integer in minor units on the wire (ADR-013).
   */
  private valueToPublished(value: OptionValue): PublishedValue {
    return {
      value_key: value.valueKey,
      label: value.label,
      sort_order: value.sortOrder,
      price_config: value.priceConfig ?? {
        type: value.priceType,
        amount_minor: value.priceAmountMinor,
      },
      ...optional('image_url', value.imageUrl),
      ...optional('color_hex', value.colorHex),
      ...optional('sku_suffix', value.skuSuffix),
      ...optional('weight_delta_grams', value.weightDeltaGrams),
      // Only ever present when true: a renderer asks "which is default?", and
      // `is_default: false` on every other value is noise on every request.
      ...(value.isDefault ? { is_default: true as const } : {}),
    };
  }

  private itemToPublished(item: PresentationalItem): PublishedItem {
    return {
      kind: item.kind,
      content: item.content,
      sort_order: item.sortOrder,
      ...optional('display', item.display),
    };
  }
}

/**
 * Include a key only when it carries a value.
 *
 * `null` and `undefined` are dropped rather than serialized. The config document
 * is fetched on a schedule by every storefront that uses it, and a null for
 * every unset optional on every option is bytes paid for on every fetch to say
 * nothing.
 */
function optional<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** An ISO timestamp, or null. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
