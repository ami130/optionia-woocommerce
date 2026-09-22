import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PRICED_TYPES, optionPricingDelta, priceConfigDelta } from './price-config-delta';
import { sumDeltas } from './line-total';

/**
 * The derivation cases, from the file the PHP suite also reads.
 *
 * `percentage.spec.ts` proves rounding and `line-total.spec.ts` proves summing.
 * Neither proved the step between them — that a published `price_config`, given
 * a base, yields a particular delta — and that step is where two evaluators
 * diverge while both suites stay green. Read `basis_points` as a percent here
 * and as basis points in PHP, and every other test in both repositories passes.
 */
interface ConfigCase {
  readonly name: string;
  readonly base_minor: number;
  readonly config: Record<string, unknown>;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

interface CurrencyCase {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly base_minor_a: number;
  readonly base_minor_b: number;
  readonly expect_delta_a: number;
  readonly expect_delta_b: number;
  readonly converts: boolean;
  /** The customer's answer, for the option-level types. Absent means value-level. */
  readonly answer?: string;
}

interface TierPriceCase {
  readonly name: string;
  readonly quantity: string;
  readonly pricing: Record<string, unknown>;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

interface UnitPriceCase {
  readonly name: string;
  readonly quantity: string;
  readonly pricing: Record<string, unknown>;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

interface TextPriceCase {
  readonly name: string;
  readonly text: string;
  readonly pricing: Record<string, unknown>;
  readonly expect_delta: number;
  readonly expect_unpriced?: string;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/shared/pricing-fixtures.json'), 'utf8'),
) as {
  config_case_count: number;
  config_cases: ConfigCase[];
  text_price_case_count: number;
  text_price_cases: TextPriceCase[];
  unit_price_case_count: number;
  unit_price_cases: UnitPriceCase[];
  tier_price_case_count: number;
  tier_price_cases: TierPriceCase[];
  currency_case_count: number;
  currency_cases: CurrencyCase[];
};

describe('priceConfigDelta', () => {
  it.each(fixture.config_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const { deltaMinor, unpriced } = priceConfigDelta(testCase.config, testCase.base_minor);

    expect(deltaMinor).toBe(testCase.expect_delta);
    expect(unpriced).toBe(testCase.expect_unpriced ?? null);

    // The total as well as the delta. A right delta that the summer ignores is
    // a live undercharge, and the two are different functions.
    expect(sumDeltas(testCase.base_minor, [deltaMinor])).toBe(
      Math.max(0, testCase.base_minor + testCase.expect_delta),
    );
  });

  it('runs every config case the fixture declares', () => {
    expect(fixture.config_cases).toHaveLength(fixture.config_case_count);
  });

  /**
   * A percentage is taken of the base, never of a running total.
   *
   * Two 50% options on 80.00 add 40.00 each — 160.00, not 180.00. Asserted here
   * rather than in the fixture because a single-option case cannot distinguish
   * the two: with one percentage, base and running total are the same number.
   */
  it('does not compound percentages', () => {
    const half = { type: 'percentage', basis_points: 5000 };
    const deltas = [half, half].map((c) => priceConfigDelta(c, 8000).deltaMinor);

    expect(deltas).toEqual([4000, 4000]);
    expect(sumDeltas(8000, deltas)).toBe(16000);
  });

  /**
   * The two implementations claim the same set of priceable types.
   *
   * A type one side charges and the other reports as unpriceable produces two
   * different totals for one configuration — and the reporting side would be
   * telling a merchant about an undercharge that is not happening.
   *
   * The PHP list is read out of the source rather than restated, so this fails
   * when `SelectionResolver::PRICED_TYPES` grows without this file growing. A
   * hand-copied list would agree with itself.
   */
  it('prices exactly the types the plugin prices', () => {
    const resolver = readFileSync(
      join(__dirname, '../../../../optioniaWooCommercePlugin/src/Engine/SelectionResolver.php'),
      'utf8',
    );

    const declaration = /public const PRICED_TYPES = array\(([^)]*)\)/.exec(resolver);

    expect(declaration).not.toBeNull();

    // `self::PRICE_TYPE_FIXED` etc — resolved through the constants beside it,
    // since the array is written in terms of them.
    const phpTypes = [...(declaration as RegExpExecArray)[1].matchAll(/self::(\w+)/g)].map(
      ([, constant]) => {
        const value = new RegExp(`private const ${constant} = '([^']+)'`).exec(resolver);

        expect(value).not.toBeNull();

        return (value as RegExpExecArray)[1];
      },
    );

    expect([...phpTypes].sort()).toEqual([...PRICED_TYPES].sort());
  });

  /**
   * A base that is not an integer number of minor units is refused, not coerced.
   *
   * `8000.5` silently floored is a total that is wrong by a minor unit and looks
   * right; the plugin's `assert_integer()` makes the same choice for the same
   * reason.
   */
  it('refuses a non-integer base', () => {
    expect(() => priceConfigDelta({ type: 'fixed', amount_minor: 500 }, 8000.5)).toThrow(RangeError);
  });

  /**
   * A value with no price config is free, and that is not an error.
   */
  it('treats an absent config as free', () => {
    expect(priceConfigDelta(null, 8000)).toEqual({ deltaMinor: 0, unpriced: null });
    expect(priceConfigDelta(undefined, 8000)).toEqual({ deltaMinor: 0, unpriced: null });
  });

  /**
   * A malformed amount is reported rather than coerced into a charge.
   *
   * `Number(x) || 0` would turn `"abc"` into a free option and `"500"` into a
   * charge nobody configured — both indistinguishable from a deliberate 0.
   */
  it('reports a malformed amount instead of guessing at it', () => {
    expect(priceConfigDelta({ type: 'fixed', amount_minor: '500' }, 8000)).toEqual({
      deltaMinor: 0,
      unpriced: 'fixed',
    });

    expect(priceConfigDelta({ type: 'percentage', basis_points: '500' }, 8000)).toEqual({
      deltaMinor: 0,
      unpriced: 'percentage',
    });
  });

  /**
   * `per_char`, from the same file the PHP suite reads.
   *
   * `measure.spec.ts` proves text → a count and the cases above prove a config
   * → a delta. Neither proved the step between, which is exactly the
   * `optionia-app` bug: pricing counted five characters while the counter
   * showed four, each half self-consistent.
   */
  describe('optionPricingDelta', () => {
    it.each(fixture.text_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.text);

      expect(deltaMinor).toBe(testCase.expect_delta);
      expect(unpriced).toBe(testCase.expect_unpriced ?? null);
    });

    it('runs every text-price case the fixture declares', () => {
      expect(fixture.text_price_cases).toHaveLength(fixture.text_price_case_count);
    });

    /**
     * The floor is on the count, so a merchant's negative amount survives.
     *
     * `Math.max(0, delta)` would pass every fixture case above and silently
     * discard the one thing a discount option is for.
     */
    it('keeps a negative amount while flooring the count', () => {
      const pricing = { type: 'per_char', amount_minor: -50, free_characters: 3 };

      expect(optionPricingDelta(pricing, 'HELLO').deltaMinor).toBe(-100);
      expect(optionPricingDelta(pricing, 'HI').deltaMinor).toBe(0);
    });

    /**
     * A type that belongs on a value is reported, not evaluated here.
     */
    /**
     * The example is `percentage` since M16.3: `tiered` moved to the option
     * level, so a test asserting it is misplaced there would assert the opposite
     * of the specification.
     */
    it('reports a value-level type found at the option level', () => {
      expect(optionPricingDelta({ type: 'percentage', basis_points: 250 }, 'anything')).toEqual({
        deltaMinor: 0,
        unpriced: 'percentage',
      });
    });

    /**
     * `fixed` at the option level is neither charged nor reported — the
     * specification prices it per value, and naming an implemented type in a
     * merchant-facing notice sends them looking for the wrong thing.
     */
    it('stays silent about an option-level fixed price', () => {
      expect(optionPricingDelta({ type: 'fixed', amount_minor: 500 }, 'x')).toEqual({
        deltaMinor: 0,
        unpriced: null,
      });
    });

    /**
     * The customer supplies the text, so the product is checked before it is
     * returned — the same guard the over-range percentage case covers.
     */
    it('reports a product that leaves the safe integer range', () => {
      const pricing = { type: 'per_char', amount_minor: Number.MAX_SAFE_INTEGER, free_characters: 0 };

      expect(optionPricingDelta(pricing, 'AB')).toEqual({ deltaMinor: 0, unpriced: 'per_char' });
    });
  });

  /**
   * `per_unit`, from the same file the PHP suite reads.
   *
   * A quantity has a far wider input range than a character count: `measure()`
   * returns a non-negative integer by construction, while a number option
   * accepts fractions and negatives unless the merchant configured otherwise.
   * The floor and the rounding are where two evaluators diverge.
   */
  describe('per_unit', () => {
    it.each(fixture.unit_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.quantity);

      expect(deltaMinor).toBe(testCase.expect_delta);

      /*
       * 🔴 The reporting half, which neither language asserted until M16.2.
       *
       * PHP returned a bare 0 at the overflow boundary while this side reported
       * `per_unit` — the two disagreeing about the same input, which is exactly
       * what this fixture exists to prevent. It could not see the disagreement
       * because no case carried an expectation for this half.
       */
      expect(unpriced).toBe(testCase.expect_unpriced ?? null);
    });

    it('runs every unit-price case the fixture declares', () => {
      expect(fixture.unit_price_cases).toHaveLength(fixture.unit_price_case_count);
    });

    /**
     * The floor is on the quantity, so a merchant's negative amount survives.
     *
     * `Math.max(0, delta)` would pass every positive case above and silently
     * discard the one thing a discount option is for.
     */
    it('floors the quantity while keeping a negative amount', () => {
      const pricing = { type: 'per_unit', amount_minor: -200 };

      expect(optionPricingDelta(pricing, '3').deltaMinor).toBe(-600);
      expect(optionPricingDelta(pricing, '-3').deltaMinor).toBe(0);
    });

    /**
     * A quantity is parsed, never coerced.
     *
     * `Number("1e3")` is 1000 and `Number(" 7 ")` is 7 — neither is what a
     * customer typing a quantity meant, and the plugin's parser refuses both.
     * Two parsers disagreeing about what counts as a number is the divergence
     * `measure()` exists to prevent for text.
     */
    it.each(['1e3', ' 7 ', 'abc', '', '0x1A', '1,234'])('refuses %p as a quantity', (raw) => {
      expect(optionPricingDelta({ type: 'per_unit', amount_minor: 200 }, raw).deltaMinor).toBe(0);
    });

    /**
     * A malformed amount charges nothing and is not reported as unpriceable:
     * `per_unit` IS priced by this build, so naming it in a merchant notice
     * would send them looking for an unsupported feature.
     */
    it('charges nothing for a malformed amount without calling the type unpriced', () => {
      expect(optionPricingDelta({ type: 'per_unit', amount_minor: '200' }, '3')).toEqual({
        deltaMinor: 0,
        unpriced: null,
      });
    });
  });

  /**
   * `tiered`, from the same file the PHP suite reads.
   *
   * The only pricing type whose amount comes from a **lookup**, so an off-by-one
   * at a boundary charges the wrong *rate* for every unit rather than being out
   * by a minor unit. The boundary cases are the point.
   */
  describe('tiered', () => {
    it.each(fixture.tier_price_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      const { deltaMinor, unpriced } = optionPricingDelta(testCase.pricing, testCase.quantity);

      expect(deltaMinor).toBe(testCase.expect_delta);
      expect(unpriced).toBe(testCase.expect_unpriced ?? null);
    });

    it('runs every tier case the fixture declares', () => {
      expect(fixture.tier_price_cases).toHaveLength(fixture.tier_price_case_count);
    });

    /**
     * The bracket does not depend on the order tiers arrive in.
     *
     * The published document preserves whatever order the dashboard stored, so a
     * lookup taking the first match would charge the 50+ rate for a quantity of
     * 5 on a document that is entirely valid.
     */
    it('picks the bracket by min_quantity, whatever the tier order', () => {
      const reversed = {
        type: 'tiered',
        tiers: [
          { min_quantity: 50, max_quantity: null, amount_minor: 60 },
          { min_quantity: 10, max_quantity: 49, amount_minor: 80 },
          { min_quantity: 1, max_quantity: 9, amount_minor: 100 },
        ],
      };

      expect(optionPricingDelta(reversed, '5').deltaMinor).toBe(500);
      expect(optionPricingDelta(reversed, '50').deltaMinor).toBe(3000);
    });

    /**
     * A malformed bracket is skipped, not fatal: the others may still price this
     * quantity, and refusing everything would take a storefront down over one
     * bad tier.
     */
    it('skips a malformed tier rather than failing the whole set', () => {
      const config = {
        type: 'tiered',
        tiers: [
          { min_quantity: 1, max_quantity: 9, amount_minor: 100 },
          { min_quantity: '10', max_quantity: null, amount_minor: 80 },
        ],
      };

      expect(optionPricingDelta(config, '5').deltaMinor).toBe(500);
    });
  });

  /**
   * Which price types follow a base a currency switcher converted.
   *
   * Not arithmetic — a **behavioural split** `PRICING-SPEC.md` §6 states as a
   * table, and a table nobody executes is prose. Only `percentage` follows the
   * base, because it is the only relative type; the rest are absolute amounts in
   * the currency they were published in.
   *
   * The pair of bases is the point: a single base cannot express "does not
   * convert" at all.
   */
  describe('currency conversion', () => {
    it.each(fixture.currency_cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      /*
       * Value-level and option-level types take different evaluators.
       *
       * `fixed` and `percentage` price a chosen value; `per_char`, `per_unit`
       * and `tiered` price the option and need the answer the customer gave. A
       * case with no `answer` is a value-level one — which is how the fixture
       * distinguishes them without a second flag.
       *
       * The option-level evaluator takes no base at all, which is *why* those
       * three cannot convert: there is nothing for a converted base to reach.
       */
      const evaluate = (base: number): number =>
        testCase.answer === undefined
          ? priceConfigDelta(testCase.config, base).deltaMinor
          : optionPricingDelta(testCase.config, testCase.answer).deltaMinor;

      const a = evaluate(testCase.base_minor_a);
      const b = evaluate(testCase.base_minor_b);

      expect(a).toBe(testCase.expect_delta_a);
      expect(b).toBe(testCase.expect_delta_b);

      if (testCase.converts) {
        expect(a).not.toBe(b);
      } else {
        expect(a).toBe(b);
      }
    });

    it('runs every currency case the fixture declares', () => {
      expect(fixture.currency_cases).toHaveLength(fixture.currency_case_count);
    });

    /**
     * Both sides of the split, or the table proves nothing: a suite holding only
     * the converting case would pass on an evaluator that converted everything.
     */
    it('covers a type that converts and one that does not', () => {
      expect(fixture.currency_cases.some((c) => c.converts)).toBe(true);
      expect(fixture.currency_cases.some((c) => !c.converts)).toBe(true);
    });
  });
});
