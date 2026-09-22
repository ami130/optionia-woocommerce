import type { AuthoringSet } from './api';

/**
 * A set as a portable JSON document (M20.8).
 *
 * ## What travels is already decided
 *
 * 🔴 **`duplication.ts` is the authority, not this file.** `copyOptionsInto`
 * and `copyableValueFields` define exactly which fields survive a copy, and an
 * export carrying less would silently lose settings a *duplicate* keeps — a
 * merchant would reasonably expect the two to agree. Two answers to "what is
 * this set, portably" is two places for them to disagree.
 *
 * ## Why no ids
 *
 * ⚠️ **An id means nothing in another set or another store.** Carrying them
 * would invite an importer to trust them, and the one place they matter —
 * rules, which target by row id — is handled by **index path** instead:
 * *"group 0, option 0"*, resolved against whatever the import creates.
 *
 * 📌 **Versioned from the first release.** An export is a file a merchant keeps
 * for months; a format with no version is one nothing can safely change.
 */

/** The format version. Bumped when the shape changes incompatibly. */
export const PORTABLE_VERSION = 1;

/** Where a rule points, as a path through the exported tree. */
export interface PortableTarget {
  readonly kind: string;
  /** `[group]`, `[group, option]` or `[group, option, value]`. */
  readonly path: number[];
}

export interface PortableSet {
  readonly version: number;
  readonly name: string;
  readonly groups: PortableGroup[];
  readonly rules: PortableRule[];
}

interface PortableGroup {
  readonly label: string;
  readonly description: string | null;
  readonly displayType: string;
  readonly isCollapsible: boolean;
  readonly isEnabled: boolean;
  readonly sortOrder: number;
  readonly options: PortableOption[];
  readonly items: PortableItem[];
}

interface PortableOption {
  readonly key: string;
  readonly label: string;
  readonly presentation: string;
  readonly isRequired: boolean;
  readonly isEnabled: boolean;
  readonly sortOrder: number;
  readonly description?: string | null;
  readonly placeholder?: string | null;
  readonly helpText?: string | null;
  readonly defaultValue?: string | null;
  readonly validation?: Record<string, unknown> | null;
  readonly pricing?: Record<string, unknown> | null;
  readonly display?: Record<string, unknown> | null;
  readonly values: PortableValue[];
}

interface PortableValue {
  readonly valueKey: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly priceType: string;
  readonly priceAmountMinor: number;
  readonly priceConfig?: Record<string, unknown> | null;
  readonly imageUrl?: string | null;
  readonly colorHex?: string | null;
  readonly groupLabel?: string | null;
  readonly skuSuffix?: string | null;
  readonly weightDeltaGrams?: number | null;
  readonly isDefault?: boolean;
  readonly isEnabled?: boolean;
}

interface PortableItem {
  readonly kind: string;
  readonly content: string;
  readonly sortOrder: number;
}

interface PortableRule {
  readonly target: PortableTarget;
  readonly action: string;
  readonly matchType: string;
  readonly conditions: { readonly option: number[]; readonly operator: string; readonly value?: unknown }[];
  readonly actionValue: Record<string, unknown> | null;
  readonly sortOrder: number;
  readonly isEnabled: boolean;
}

/**
 * Where a row sits in the tree, as indices.
 *
 * Returns `null` when the id is not in the tree — a rule targeting a row that
 * is not there cannot be exported meaningfully, and guessing would be worse.
 */
function pathOf(set: AuthoringSet, id: string): { kind: string; path: number[] } | null {
  for (const [g, group] of set.groups.entries()) {
    if (group.id === id) {
      return { kind: 'group', path: [g] };
    }

    for (const [o, option] of group.options.entries()) {
      if (option.id === id) {
        return { kind: 'option', path: [g, o] };
      }

      for (const [v, value] of option.values.entries()) {
        if (value.id === id) {
          return { kind: 'value', path: [g, o, v] };
        }
      }
    }
  }

  return null;
}

/** Turn a set into the document a merchant downloads. */
export function toPortable(set: AuthoringSet): PortableSet {
  const groups = set.groups.map((group) => ({
    label: group.label,
    description: group.description,
    displayType: group.displayType,
    isCollapsible: group.isCollapsible,
    isEnabled: group.isEnabled,
    sortOrder: group.sortOrder,
    options: group.options.map((option) => ({
      key: option.key,
      label: option.label,
      presentation: option.presentation,
      isRequired: option.isRequired,
      isEnabled: option.isEnabled,
      sortOrder: option.sortOrder,
      description: option.description,
      placeholder: option.placeholder,
      helpText: option.helpText,
      defaultValue: option.defaultValue,
      validation: option.validation,
      pricing: option.pricing,
      display: option.display,
      values: option.values.map((value) => ({
        valueKey: value.valueKey,
        label: value.label,
        sortOrder: value.sortOrder,
        priceType: value.priceType,
        priceAmountMinor: value.priceAmountMinor,
        priceConfig: value.priceConfig,
        imageUrl: value.imageUrl,
        colorHex: value.colorHex,
        groupLabel: value.groupLabel,
        /* 🔴 Fulfilment data — the pair a naive export forgets. */
        skuSuffix: value.skuSuffix,
        weightDeltaGrams: value.weightDeltaGrams,
        isDefault: value.isDefault,
        isEnabled: value.isEnabled,
      })),
    })),
    items: group.items.map((item) => ({
      kind: item.kind,
      content: item.content,
      sortOrder: item.sortOrder,
    })),
  }));

  /*
   * 🔴 **A rule whose target is not in the tree is DROPPED, not guessed.** It
   * cannot mean anything after an import, and inventing a target would produce
   * a rule the merchant never wrote acting on a row they did not choose.
   */
  const rules = (set.rules ?? []).flatMap((rule) => {
    const target = pathOf(set, rule.targetId);

    if (target === null) {
      return [];
    }

    const conditions = rule.conditions.flatMap((condition) => {
      const at = pathOf(set, condition.optionId);

      return at === null
        ? []
        : [{ option: at.path, operator: condition.operator, value: condition.value }];
    });

    return [
      {
        target,
        action: rule.action,
        matchType: rule.matchType,
        conditions,
        actionValue: rule.actionValue,
        sortOrder: rule.sortOrder,
        isEnabled: rule.isEnabled,
      },
    ];
  });

  return { version: PORTABLE_VERSION, name: set.name, groups, rules };
}
