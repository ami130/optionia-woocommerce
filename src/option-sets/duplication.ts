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
 * `optionId` / `optionGroupId` are the *new* parent, which only the caller
 * knows. `valueKey`, `label` and `sortOrder` may be rewritten by the caller —
 * a value duplicated in place needs a fresh key, one copied into a new option
 * does not.
 */
export const COPY_DECIDED_BY_CALLER = [
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'optionId',
  'optionGroupId',
  'valueKey',
  'label',
  'sortOrder',
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
