import { describe, expect, it } from 'vitest';

import { priceConfigDelta } from '@/lib/money/price-config-delta';
import { formatAmount } from '@/lib/money/money';

import { describedBy, displaySettings, guidance, valuePrice } from './option-view';

const price = (
  config: Record<string, unknown> | null,
  display: 'delta' | 'total' | 'hidden' = 'delta',
  base = 10000,
) => valuePrice(config, display, base, formatAmount, priceConfigDelta);

describe('guidance', () => {
  it('returns the three blocks in the order the storefront renders them', () => {
    const blocks = guidance({
      id: 'o1',
      description: 'A description',
      help_text: 'Some help',
      display: { tooltip: 'A tip' },
    });

    expect(blocks.map((b) => b.kind)).toEqual(['description', 'help', 'tooltip']);
    expect(blocks.map((b) => b.id)).toEqual([
      'optionia-desc-o1',
      'optionia-help-o1',
      'optionia-tip-o1',
    ]);
  });

  /**
   * ⚠️ **`tooltip` lives on `display`, the other two on the option.** A port
   * that read all three from one place would silently drop every tooltip.
   */
  it('reads the tooltip from display rather than from the option', () => {
    expect(guidance({ id: 'o1', display: { tooltip: 'A tip' } })).toHaveLength(1);
    expect(guidance({ id: 'o1', tooltip: 'A tip' } as never)).toHaveLength(0);
  });

  /**
   * An empty element is worse than no element: `aria-describedby` would point a
   * screen reader at nothing.
   */
  it('skips text that is only whitespace', () => {
    expect(guidance({ id: 'o1', description: '   ', help_text: '' })).toEqual([]);
  });

  it('returns nothing for an option with no id, since the ids would collide', () => {
    expect(guidance({ description: 'A description' })).toEqual([]);
  });
});

describe('describedBy', () => {
  it('joins the ids in order', () => {
    expect(describedBy({ id: 'o1', description: 'd', help_text: 'h' })).toBe(
      'optionia-desc-o1 optionia-help-o1',
    );
  });

  /**
   * 🔴 **`undefined`, not `''`.** React omits the attribute entirely for
   * `undefined`; an empty string emits `aria-describedby=""`, which points at
   * nothing and is worse than silence.
   */
  it('is undefined when there is no guidance at all', () => {
    expect(describedBy({ id: 'o1' })).toBeUndefined();
  });
});

describe('displaySettings', () => {
  it('applies every default when nothing is configured', () => {
    expect(displaySettings({})).toEqual({
      columns: 1,
      swatchSize: 'medium',
      priceDisplay: 'delta',
      collapsed: false,
      tooltip: '',
    });
  });

  it('keeps values the storefront accepts', () => {
    expect(
      displaySettings({
        display: {
          columns: 4,
          swatch_size: 'large',
          price_display: 'hidden',
          collapsed_by_default: true,
          tooltip: ' hi ',
        },
      }),
    ).toEqual({
      columns: 4,
      swatchSize: 'large',
      priceDisplay: 'hidden',
      collapsed: true,
      tooltip: 'hi',
    });
  });

  it.each([0, 7, -1])('falls back to one column for %s', (columns) => {
    expect(displaySettings({ display: { columns } }).columns).toBe(1);
  });

  /**
   * ⚠️ **A non-integer is unconfigured, not rounded.** The plugin tests
   * `is_int`, so `2.5` is not "2".
   */
  it('falls back to one column for a non-integer', () => {
    expect(displaySettings({ display: { columns: 2.5 } }).columns).toBe(1);
  });

  it('falls back to medium for an unknown swatch size', () => {
    expect(displaySettings({ display: { swatch_size: 'huge' } }).swatchSize).toBe('medium');
  });

  /** `delta` is the honest framing: an option adds to a price already seen. */
  it('falls back to delta for an unknown price display', () => {
    expect(displaySettings({ display: { price_display: 'guess' } }).priceDisplay).toBe('delta');
  });
});

describe('valuePrice', () => {
  /* The storefront's own cases, from OptionValuePriceTest. */
  it('signs a surcharge', () => {
    expect(price({ type: 'fixed', amount_minor: 1000 }).label).toBe('+10.00');
  });

  it('signs a discount', () => {
    expect(price({ type: 'fixed', amount_minor: -500 }).label).toBe('-5.00');
  });

  it('prints nothing when the price display is hidden', () => {
    expect(price({ type: 'fixed', amount_minor: 1000 }, 'hidden').label).toBe('');
  });

  /**
   * `total` renders as `delta` (ADR-065): no template has the base price, so a
   * "total" would be a delta wearing the wrong label.
   */
  it('renders total exactly as delta', () => {
    expect(price({ type: 'fixed', amount_minor: 1000 }, 'total').label).toBe(
      price({ type: 'fixed', amount_minor: 1000 }, 'delta').label,
    );
  });

  /** `+0.00` beside a free choice reads as a mistake. */
  it('prints nothing for a zero', () => {
    expect(price({ type: 'fixed', amount_minor: 0 }).label).toBe('');
  });

  /**
   * 🔴 **The deliberate divergence (ADR-107).** The storefront prints nothing
   * here — `OptionValuePriceTest::test_an_unpriceable_type_prints_nothing`
   * asserts `''` for a percentage — because a storefront guessing would
   * contradict the server. The preview is not guessing: it runs the server's
   * own evaluator against a base it states.
   *
   * 2.5% of £100.00 is £2.50.
   */
  it('prices a percentage, which the storefront deliberately does not', () => {
    const priced = price({ type: 'percentage', basis_points: 250 });

    expect(priced.label).toBe('+2.50');
    expect(priced.unpriced).toBeNull();
  });

  /**
   * ⚠️ **And flags that the number is meaningless without its base.** A caller
   * rendering this must state what the percentage is of.
   */
  it('marks a percentage as needing its base stated', () => {
    expect(price({ type: 'percentage', basis_points: 250 }).needsBase).toBe(true);
    expect(price({ type: 'fixed', amount_minor: 1000 }).needsBase).toBe(false);
  });

  it('reports a type it cannot price rather than printing a wrong number', () => {
    const priced = price({ type: 'per_unit', amount_minor: 100 });

    expect(priced.label).toBe('');
    expect(priced.unpriced).toBe('per_unit');
  });

  it('prices a percentage against the base it is given, not a fixed one', () => {
    expect(valuePrice(
      { type: 'percentage', basis_points: 250 },
      'delta',
      20000,
      formatAmount,
      priceConfigDelta,
    ).label).toBe('+5.00');
  });
});
