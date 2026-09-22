import { OptionRule } from './entities/option-rule.entity';
import { OptionValue } from './entities/option-value.entity';
import { PresentationalItem } from './entities/presentational-item.entity';

/**
 * What a copied row carries, in one place.
 *
 * 🔴 **Four hand-written field lists, and a new column reached one of them.**
 * `groupLabel` was added to `option-values.service.duplicate()` and missed in the
 * set, group and option duplicate paths — so duplicating a set silently dropped
 * every `<optgroup>` heading. Measured: `'Sizes'` in the source, `null` in the
 * copy. Presentational items were worse: the set and group paths never copied
 * them at all, so a duplicated set lost its headings entirely.
 *
 * Nothing failed. Every suite stayed green, because **no test asserted that a
 * copy is complete** — the same shape as the cross-kind reorder bug: a green run
 * over real data loss.
 *
 * ⚠️ **These helpers are the only place a copy's fields are listed.** A new
 * column on `option_values` or `presentational_items` is added here once, and
 * `duplication.spec.ts` fails until it is — the test compares against the
 * entity's own column metadata rather than a second hand-written list, so it
 * cannot drift the same way.
 */

/**
 * Columns every copy path deliberately decides for itself.
 *
 * `id`, `createdAt`, `updatedAt` and `deletedAt` belong to the new row.
 * `optionId` / `optionGroupId` / `optionSetId` are the *new* parent, which only
 * the caller knows. `valueKey`, `label` and `sortOrder` may be rewritten by the
 * caller — a value duplicated in place needs a fresh key, one copied into a new
 * option does not.
 *
 * 🔴 **`targetId` and `conditions` are here for a stronger reason than the
 * others.** A rule points at rows by id, and a copy has new ids, so carrying
 * them verbatim would aim the copied rule at the **source set's** rows — a rule
 * that works and governs the wrong document. The caller must remap both through
 * its id map, and `duplication.spec.ts` asserts they are absent from the copy
 * helper so the remap cannot be forgotten.
 */
export const COPY_DECIDED_BY_CALLER = [
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'optionId',
  'optionGroupId',
  'optionSetId',
  'valueKey',
  'label',
  'sortOrder',
  'targetId',
  'conditions',
] as const;

/**
 * Everything a copied `OptionValue` inherits from its source.
 *
 * ⚠️ **`isDefault` is deliberately absent** — it is passed by the caller, because
 * duplicating a value *within one option* must not create a second default (two
 * defaults is a document the renderer cannot resolve), while copying a whole
 * option into a new set must keep it.
 */
export function copyableValueFields(source: OptionValue): Omit<
  Partial<OptionValue>,
  'id' | 'optionId' | 'valueKey' | 'label' | 'sortOrder' | 'isDefault'
> {
  return {
    priceType: source.priceType,
    priceAmountMinor: source.priceAmountMinor,
    priceConfig: source.priceConfig,
    imageUrl: source.imageUrl,
    colorHex: source.colorHex,
    /*
     * A copy sits under the same heading: duplicating "Small" out of "Sizes"
     * into no group at all would move it in the rendered list.
     */
    groupLabel: source.groupLabel,
    skuSuffix: source.skuSuffix,
    weightDeltaGrams: source.weightDeltaGrams,
    // Disabled work stays disabled, as everywhere else.
    isEnabled: source.isEnabled,
  };
}

/**
 * Everything a copied `PresentationalItem` inherits.
 *
 * 🔴 **No duplicate path copied these at all.** A merchant duplicating a set to
 * make a seasonal variant lost every heading, paragraph and divider — the
 * structure that made a twelve-option form readable, gone with no error.
 *
 * `sortOrder` is inherited rather than reassigned: items share the scale with
 * options, and renumbering only one of the two lists would break the
 * interleaving the storefront renders.
 */
export function copyableItemFields(source: PresentationalItem): Omit<
  Partial<PresentationalItem>,
  'id' | 'optionGroupId'
> {
  return {
    kind: source.kind,
    content: source.content,
    sortOrder: source.sortOrder,
    display: source.display,
  };
}

/**
 * Everything a copied `OptionRule` inherits.
 *
 * 🔴 **`duplicate()` did not copy rules at all**, found by auditing Stage 17-1.
 * A merchant duplicating a configured set got one with **every piece of its
 * conditional logic silently removed** — no error, and a copy that looks right
 * until a customer sees a field that should have been hidden.
 *
 * ⚠️ **This is the third time this exact bug has been found in this file.**
 * `groupLabel` reached one copy path and not the others; presentational items
 * were copied by none. Each time the cause was the same — a new thing to copy,
 * and four hand-written lists — and each time every suite stayed green, because
 * nothing asserted a copy was *complete*.
 *
 * ## What the caller decides, and why it is not simply omitted
 *
 * 🔴 **`targetId` is deliberately NOT here, and a rule cannot be copied without
 * remapping it.** It points at a group, option or value **in the source set**,
 * and the copy created new rows with new ids. Copying it verbatim produces a
 * rule aimed at another set's row — which is worse than dropping the rule,
 * because it would silently govern the wrong document.
 *
 * The same is true of every `optionId` inside `conditions`.
 *
 * So this helper returns only what is safe to carry, and the caller must supply
 * `targetId` and `conditions` from its own id map. `duplication.spec.ts` asserts
 * both are absent, so a future caller cannot forget the remap by accident.
 */
export function copyableRuleFields(source: OptionRule): Omit<
  Partial<OptionRule>,
  'id' | 'optionSetId' | 'targetId' | 'conditions'
> {
  return {
    targetType: source.targetType,
    action: source.action,
    /*
     * 🔴 **The payload travels with the action, and the copy-completeness guard
     * caught its absence the moment M17.4 added the column.**
     *
     * A duplicated `set_price` rule without its `actionValue` is a rule with no
     * amount to set — it would evaluate, find nothing, and leave the price the
     * merchant authored, silently. The fourth thing this file has caught, after
     * `groupLabel`, presentational items and rules themselves.
     *
     * Unlike `targetId` and `conditions`, it carries **no ids**, so it is safe
     * verbatim: an amount and a value key mean the same thing in any set.
     */
    actionValue: source.actionValue,
    matchType: source.matchType,
    sortOrder: source.sortOrder,
    /*
     * Disabled work stays disabled, as everywhere else in this file — and the
     * reason travels with it. A rule disabled because its target was deleted
     * must not silently come back enabled in a copy, because the target is still
     * gone.
     */
    isEnabled: source.isEnabled,
    disabledReason: source.disabledReason,
  };
}
