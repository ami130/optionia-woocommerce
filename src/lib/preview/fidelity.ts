import { priceConfigDelta } from '@/lib/money/price-config-delta';

import { optionPricingKinds } from '@/lib/option-sets/option-pricing';

import { answerInput } from './answer-input';

/**
 * How faithfully the preview reproduces one option type.
 *
 * 🔴 **Numbers, never markup** (ADR-109). The storefront's rendered fixture
 * carries `data-optionia-price-type` and `data-optionia-price` on every priced
 * value — behaviour a machine can read — and the preview runs the same
 * evaluators. Comparing the two as **arithmetic** is the only comparison that
 * means anything, because the two renderers are *meant* to differ in markup.
 *
 * ⚠️ **This cannot see a wrong control.** F38 measured exactly that: a `range`
 * drawn as a spinbox instead of a slider, with the values agreeing. Control
 * shape is pinned by `set-preview.interactive.test.tsx` against the same
 * fixture; this says whether the *numbers* agree.
 */
export type Fidelity = 'exact' | 'approximate' | 'not previewed';

export interface TypeFidelity {
  readonly type: string;
  readonly fidelity: Fidelity;
  /** Why, in a sentence a merchant-facing document can carry. */
  readonly reason: string;
  /** Priced values compared, and how many agreed. */
  readonly compared: number;
  readonly agreed: number;
}

/** One priced value, as the storefront's own markup reports it. */
export interface StorefrontValue {
  readonly valueId: string;
  readonly priceType: string;
  readonly priceMinor: number;
}

/**
 * Read every priced value out of one type's rendered markup.
 *
 * ⚠️ **The attributes are matched without `[^>]*`**, for the reason the plugin's
 * own contract test records: the templates build attributes inside
 * `<?php if ( … ) : ?>` blocks, so a pattern that stops at `?>` *"reports 'no
 * price attribute' for a template full of them."*
 */
export function storefrontValues(markup: string): readonly StorefrontValue[] {
  const pattern =
    /data-optionia-value="([^"]+)"[\s\S]*?data-optionia-price-type="([^"]+)"[\s\S]*?data-optionia-price="([^"]+)"/g;

  return [...markup.matchAll(pattern)].map((match) => ({
    valueId: match[1],
    priceType: match[2],
    priceMinor: Number(match[3]),
  }));
}

/**
 * Compare one type's storefront prices against the preview's own evaluator.
 *
 * @param type The registry type.
 * @param markup That type's rendered storefront markup.
 * @param baseMinor The base a percentage resolves against.
 */
/**
 * What `generate-fixtures.php` authors for every priced value.
 *
 * 🔴 **The second source the comparison needs.** Reading a price out of the
 * markup and feeding it to the evaluator proves only that the evaluator echoes
 * its input — measured, a mutation replacing the amount check with `>= 0`
 * survived. The authored amount is what makes it a *comparison*: the storefront
 * must publish what the merchant configured, and the preview must price that to
 * the same number.
 *
 * ⚠️ **Asserted against the generator**, so a fixture regenerated with a
 * different amount fails here rather than quietly agreeing with itself.
 */
export const AUTHORED_VALUE_MINOR = 1050;

export function compareType(type: string, markup: string, baseMinor: number): TypeFidelity {
  const values = storefrontValues(markup);
  const input = answerInput(type);

  if (values.length === 0) {
    /*
     * No priced value is not a failure. Nine types take no values at all, and
     * `file_input` takes them but its template draws none — an upload has no
     * choice list. Both are honest "nothing to compare here" rather than a gap.
     */
    /*
     * ⚠️ **Three reasons, not two.** A type with no per-value price is either
     * priced at the **option** level (`per_char` on text, `per_unit`/`tiered` on
     * numbers), or carries no price at all — the three date and time pickers.
     *
     * ✏️ **The first version said "priced at the option level" for all of
     * them**, which is false for a date picker: `optionPricingKinds` gives it
     * nothing. A generated document asserting something untrue is worse than a
     * hand-written one, because it looks measured.
     */
    const kinds = optionPricingKinds(type);

    if (input === 'none') {
      return {
        type,
        fidelity: 'not previewed',
        reason: 'The customer supplies no answer here, so there is nothing to price.',
        compared: 0,
        agreed: 0,
      };
    }

    return {
      type,
      fidelity: 'exact',
      reason:
        kinds.length > 0
          ? `Priced at the option level (${kinds.join(', ')}) rather than per value, so no per-value price is published.`
          : 'Carries no price of its own, so there is nothing to compare.',
      compared: 0,
      agreed: 0,
    };
  }

  const agreed = values.filter((value) => {
    /*
     * The preview's own path: the published price config, through the evaluator
     * the storefront's server also runs. The fixture publishes `amount_minor`
     * already, so this is the same shape `previewTree()` produces.
     */
    const priced = priceConfigDelta(
      { type: value.priceType, amount_minor: value.priceMinor },
      baseMinor,
    );

    /*
     * Three things must line up, and the third is what makes this a comparison
     * rather than an echo: the evaluator can price the type, its arithmetic
     * matches the published amount, and that amount is what the fixture
     * **authored**. Without the last, the markup and the evaluator agree with
     * each other however wrong both are.
     *
     * ⚠️ **The first two do not mutate against today's fixtures, and are kept
     * deliberately.** Measured: of the five price types, only `fixed` evaluates
     * to the authored `1050` — every other gives `0` or reports itself
     * unpriceable — so the authored check catches those cases first. They state
     * the contract this comparison rests on, and a fixture that ever authored a
     * percentage would need them. Deleting correct logic because today's data
     * cannot distinguish it is how a guard quietly narrows.
     */
    return (
      priced.unpriced === null &&
      priced.deltaMinor === value.priceMinor &&
      value.priceMinor === AUTHORED_VALUE_MINOR
    );
  }).length;

  return {
    type,
    fidelity: agreed === values.length ? 'exact' : 'approximate',
    reason:
      agreed === values.length
        ? 'Every published price evaluates to the amount the storefront charges.'
        : `${values.length - agreed} of ${values.length} prices disagree with the storefront.`,
    compared: values.length,
    agreed,
  };
}
