import { describe, expect, it } from 'vitest';

import type { AuthoringSet } from '@/lib/option-sets/api';
import { optionPricingDelta, priceConfigDelta } from '@/lib/money/price-config-delta';
import { toPublishedPriceConfig } from '@/lib/money/to-wire-price-config';
import { evaluateRules } from '@/lib/rules/rule-evaluator';

import { previewTree } from './preview-tree';

function value(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    valueKey: 'gold',
    label: 'Gold',
    sortOrder: 0,
    priceType: 'fixed',
    priceAmountMinor: 500,
    isEnabled: true,
    ...over,
  } as AuthoringSet['groups'][number]['options'][number]['values'][number];
}

function option(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    key: 'finish',
    label: 'Finish',
    presentation: 'dropdown',
    isRequired: false,
    sortOrder: 0,
    isEnabled: true,
    values: [value()],
    ...over,
  } as AuthoringSet['groups'][number]['options'][number];
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    label: 'Materials',
    description: null,
    sortOrder: 0,
    isEnabled: true,
    displayType: 'inline',
    isCollapsible: false,
    options: [option()],
    items: [],
    ...over,
  } as AuthoringSet['groups'][number];
}

function set(over: Partial<AuthoringSet> = {}): AuthoringSet {
  return {
    id: 's1',
    storeId: 'store',
    name: 'Set',
    status: 'draft',
    version: 1,
    rowVersion: 1,
    publishedAt: null,
    publishedConfigVersion: 0,
    groups: [group()],
    ...over,
  } as AuthoringSet;
}

describe('previewTree', () => {
  describe('the four filters', () => {
    it('drops a disabled group', () => {
      const tree = previewTree(set({ groups: [group({ isEnabled: false })] }));

      expect(tree.groups).toHaveLength(0);
    });

    it('drops a disabled option', () => {
      const tree = previewTree(
        set({ groups: [group({ options: [option({ isEnabled: false })] })] }),
      );

      expect(tree.groups[0].options).toHaveLength(0);
    });

    it('drops a disabled value', () => {
      const tree = previewTree(
        set({
          groups: [group({ options: [option({ values: [value({ isEnabled: false })] })] })],
        }),
      );

      expect(tree.groups[0].options[0].values).toHaveLength(0);
    });

    it('drops a disabled rule', () => {
      const tree = previewTree(
        set({
          rules: [
            {
              id: 'r1',
              targetType: 'option',
              targetId: 'o1',
              action: 'hide',
              matchType: 'all',
              conditions: [],
              actionValue: null,
              sortOrder: 0,
              isEnabled: false,
              disabledReason: null,
            },
          ],
        }),
      );

      expect(tree.rules).toHaveLength(0);
    });

    it('keeps everything that is enabled', () => {
      const tree = previewTree(set());

      expect(tree.groups[0].options[0].values).toHaveLength(1);
    });
  });

  /**
   * 🔴 **Presentational items carry no `isEnabled`**, so there is no fifth
   * filter — a heading cannot be disabled, only deleted. They survive through
   * the group spread rather than by being named, which is why this is pinned:
   * a refactor from spread to explicit construction would drop them silently.
   *
   * ⚠️ **Items and options share ONE `sortOrder` scale**, so losing the items
   * does not merely hide a heading — it reorders what remains.
   */
  it('keeps presentational items, which have no enabled flag to filter on', () => {
    const tree = previewTree(
      set({
        groups: [
          group({
            items: [{ id: 'i1', kind: 'heading', content: 'Engraving', sortOrder: 1 }],
          }),
        ],
      }),
    );

    expect(tree.groups[0].items).toEqual([
      { id: 'i1', kind: 'heading', content: 'Engraving', sortOrder: 1 },
    ]);
  });

  /**
   * 🔴 **The trap.** `AuthoringValue.isEnabled` is optional where group, option
   * and rule are required, and the dashboard's own fixtures build values without
   * it. `.filter((v) => v.isEnabled)` would drop every one of them — a preview
   * showing an empty dropdown for an option the storefront renders in full.
   */
  it('keeps a value whose flag was never sent', () => {
    const bare = value();
    delete (bare as unknown as Record<string, unknown>).isEnabled;

    const tree = previewTree(
      set({ groups: [group({ options: [option({ values: [bare] })] })] }),
    );

    expect(tree.groups[0].options[0].values).toHaveLength(1);
  });

  /**
   * A set whose rules have not been loaded — what `createSet` and `duplicateSet`
   * return — previews with none rather than throwing.
   */
  it('treats an unloaded rule list as no rules', () => {
    expect(previewTree(set()).rules).toEqual([]);
  });

  describe('the dialect split (ADR-103)', () => {
    /**
     * 🔴 **The regression that has bitten twice.** The authoring tree stores
     * `amountMinor`; `priceConfigDelta` reads `amount_minor`. Handing it the raw
     * tree gives a delta of zero and "could not be priced" for every real
     * configuration.
     */
    it('converts option pricing into the dialect the price evaluator reads', () => {
      const tree = previewTree(
        set({
          groups: [
            group({
              options: [
                option({ pricing: { type: 'per_unit', amountMinor: 250 } }),
              ],
            }),
          ],
        }),
      );

      expect(tree.groups[0].options[0].pricing).toEqual({
        type: 'per_unit',
        amount_minor: 250,
      });
    });

    /**
     * 🔴 **The defect an audit found in step 3.** The serializer applies three
     * per-option transforms and this applied two, so every validation rule
     * reached the preview in the authoring spelling. Measured at the time:
     * `{ maxLength: 20, minSelections: 1, integerOnly: true }` came back
     * unchanged, where the storefront reads `max_length`, `min_selections` and
     * `integer_only`.
     *
     * A renderer enforcing the limit would have honoured a rule the shop does
     * not — a merchant sets a 20-character engraving limit, the preview obeys
     * it, the customer types 200.
     */
    it('converts validation into the dialect the storefront reads', () => {
      const tree = previewTree(
        set({
          groups: [
            group({
              options: [
                option({
                  validation: { maxLength: 20, minSelections: 1, integerOnly: true },
                }),
              ],
            }),
          ],
        }),
      );

      expect(tree.groups[0].options[0].validation).toEqual({
        max_length: 20,
        min_selections: 1,
        integer_only: true,
      });
    });

    it('converts display into the dialect the storefront reads', () => {
      const tree = previewTree(
        set({
          groups: [group({ options: [option({ display: { collapsedByDefault: true } })] })],
        }),
      );

      expect(tree.groups[0].options[0].display).toEqual({ collapsed_by_default: true });
    });

    /**
     * 🔴 **Rules stay as authored.** `rule-evaluator` reads `targetType` and
     * `matchType`; converting them would leave the evaluator matching nothing —
     * the mirror image of the pricing defect, and the reason ADR-103 exists.
     */
    it('leaves rules in the dialect the rule evaluator reads', () => {
      const rule = {
        id: 'r1',
        targetType: 'option',
        targetId: 'o1',
        action: 'hide',
        matchType: 'all',
        conditions: [{ optionId: 'o2', operator: 'equals', value: 'yes' }],
        actionValue: null,
        sortOrder: 0,
        isEnabled: true,
        disabledReason: null,
      };

      const tree = previewTree(set({ rules: [rule as never] }));

      expect(tree.rules[0]).toMatchObject({ targetType: 'option', matchType: 'all' });
    });
  });

  describe('end to end through the real evaluators', () => {
    /**
     * Not a shape assertion: the converted tree is fed to the evaluator the
     * storefront uses, and must produce a real price. This is what the two
     * previous failures would have caught.
     */
    it('prices a real option-level config through the preview path', () => {
      const tree = previewTree(
        set({
          groups: [
            group({
              options: [option({ pricing: { type: 'per_unit', amountMinor: 250 } })],
            }),
          ],
        }),
      );

      /*
       * `optionPricingDelta`, not `priceConfigDelta`: option-level pricing is
       * charged against what the customer typed, and the value-level evaluator
       * has no quantity to charge against — it reports `per_unit` as unpriced.
       */
      const priced = optionPricingDelta(
        tree.groups[0].options[0].pricing as Record<string, unknown>,
        '3',
      );

      expect(priced.unpriced).toBeNull();
      expect(priced.deltaMinor).toBe(750);
    });

    /**
     * ✏️ **This test used to convert the value itself before pricing**, which is
     * why it passed while the tree handed out the stored spelling — it proved
     * the *converter* worked, not that the tree was safe. It now prices straight
     * off the tree, which is the property that actually matters.
     *
     * ⚠️ **And its fixture had no `priceConfig` at all**, so the converter took
     * its fallback branch and the camelCase JSON was never exercised. The
     * percentage case below is the one that catches it.
     */
    it('prices a surviving value straight off the tree', () => {
      const tree = previewTree(set());
      const surviving = tree.groups[0].options[0].values[0];

      const priced = priceConfigDelta(surviving.priceConfig, 5000);

      expect(priced.unpriced).toBeNull();
      expect(priced.deltaMinor).toBe(500);
    });

    /**
     * 🔴 **The defect the final audit found.** A value carrying
     * `{ type: 'percentage', basisPoints: 250 }` came off this tree unchanged,
     * and pricing it gave `{ deltaMinor: 0, unpriced: 'percentage' }` — a 2.5%
     * surcharge charged as **nothing**. Verbatim the regression ADR-103 exists
     * to prevent.
     *
     * The stored spelling is `basisPoints`; the evaluator reads `basis_points`.
     */
    it('prices a stored percentage config straight off the tree', () => {
      const tree = previewTree(
        set({
          groups: [
            group({
              options: [
                option({
                  values: [
                    value({
                      priceType: 'percentage',
                      priceAmountMinor: 0,
                      priceConfig: { type: 'percentage', basisPoints: 250 },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );

      const priced = priceConfigDelta(tree.groups[0].options[0].values[0].priceConfig, 10000);

      expect(priced.unpriced).toBeNull();
      expect(priced.deltaMinor).toBe(250);
    });

    /**
     * A value with no JSON gets its price from the columns, exactly as the
     * serializer does — `price_config` is unconditional in the document, so it
     * is unconditional here.
     */
    it('synthesises a price config for a value that has no JSON', () => {
      const tree = previewTree(set());

      expect(tree.groups[0].options[0].values[0].priceConfig).toEqual({
        type: 'fixed',
        amount_minor: 500,
      });
    });

    /**
     * 🔴 **The trap this change introduces, pinned so it is not discovered by a
     * merchant.** Converting twice reads `amountMinor` off an object that
     * already says `amount_minor`, yielding `undefined` and a zero price. The
     * type system cannot refuse it — see `PreviewValue` — so a test does.
     */
    it('is already converted, so converting again would destroy the amount', () => {
      const tree = previewTree(set());
      const surviving = tree.groups[0].options[0].values[0];

      const twice = toPublishedPriceConfig(surviving.priceConfig, {
        priceType: surviving.priceType,
        priceAmountMinor: surviving.priceAmountMinor,
      });

      expect(twice).toEqual({ type: 'fixed', amount_minor: undefined });
      expect(priceConfigDelta(twice, 5000).unpriced).toBe('fixed');
    });

    /**
     * 🔴 **A disabled rule must not fire.** The storefront never receives it, so
     * a preview that evaluated it would show the merchant an interaction that
     * cannot happen.
     */
    it('does not fire a disabled rule', () => {
      const disabled = {
        id: 'r1',
        targetType: 'option',
        targetId: 'o1',
        action: 'hide',
        matchType: 'all',
        conditions: [{ optionId: 'o2', operator: 'equals', value: 'yes' }],
        actionValue: null,
        sortOrder: 0,
        isEnabled: false,
        disabledReason: null,
      };

      const tree = previewTree(set({ rules: [disabled as never] }));
      const outcome = evaluateRules(
        tree.rules as never,
        { o2: 'yes' },
        new Map([['o1', ['o1']]]),
      );

      expect(outcome.states.get('o1')?.hidden ?? false).toBe(false);
    });

    /**
     * The same rule enabled *does* fire — otherwise the test above would pass
     * against a preview that never evaluates anything at all.
     */
    it('fires the same rule when it is enabled', () => {
      const enabled = {
        id: 'r1',
        targetType: 'option',
        targetId: 'o1',
        action: 'hide',
        matchType: 'all',
        conditions: [{ optionId: 'o2', operator: 'equals', value: 'yes' }],
        actionValue: null,
        sortOrder: 0,
        isEnabled: true,
        disabledReason: null,
      };

      const tree = previewTree(set({ rules: [enabled as never] }));
      const outcome = evaluateRules(
        tree.rules as never,
        { o2: 'yes' },
        new Map([['o1', ['o1']]]),
      );

      expect(outcome.states.get('o1')?.hidden).toBe(true);
    });
  });
});
