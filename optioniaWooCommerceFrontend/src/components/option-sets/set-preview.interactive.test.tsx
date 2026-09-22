import { afterEach, describe, expect, it } from 'vitest';

import type { AuthoringSet } from '@/lib/option-sets/api';

import { SetPreview } from './set-preview';

/**
 * 🔴 **M21.3 is about what a customer's choices DO.** A preview that draws the
 * set but never fires a rule answers *"what does this look like?"* and leaves
 * *"what happens when they pick that?"* — which is the question rules exist for,
 * and the one a merchant cannot answer any other way without publishing.
 *
 * Rendered and clicked, because the evaluation is driven by state: reasoning
 * about it would prove the wiring compiles, not that it runs.
 */
const value = (over: Record<string, unknown> = {}) => ({
  id: 'v1', valueKey: 'gold', label: 'Gold', sortOrder: 0,
  priceType: 'fixed', priceAmountMinor: 0, isEnabled: true, ...over,
});

const option = (over: Record<string, unknown> = {}) => ({
  id: 'o1', key: 'finish', label: 'Finish', presentation: 'dropdown',
  isRequired: false, sortOrder: 0, isEnabled: true, values: [], ...over,
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', targetType: 'option', targetId: 'o2', action: 'hide',
  matchType: 'all', conditions: [], actionValue: null, sortOrder: 0,
  isEnabled: true, disabledReason: null, ...over,
});

const set = (options: unknown[], rules: unknown[] = []) => ({
  id: 's1', storeId: 'store', name: 'Set', status: 'draft', version: 1, rowVersion: 1,
  publishedAt: null, publishedConfigVersion: 0, rules,
  groups: [{
    id: 'g1', label: 'Materials', description: null, sortOrder: 0, isEnabled: true,
    displayType: 'inline', isCollapsible: false, items: [], options,
  }],
}) as unknown as AuthoringSet;

/*
 * ⚠️ **Explicit cleanup, because this project registers no `setupFiles`.**
 * Testing-library's automatic `afterEach` only runs when its setup file is
 * loaded; without it every `render` stacks into one document, and the second
 * test's `getByRole` finds both copies. Measured — three tests failed with
 * *"Found multiple elements"* before this was added.
 */
afterEach(async () => {
  const { cleanup } = await import('@testing-library/react');

  cleanup();
});

const PRODUCTS = [
  {
    id: 'p1', externalId: '20', name: 'Custom Hoodie', sku: null,
    type: 'simple', priceMinor: 10000, status: 'publish',
    permalink: null, imageUrl: null,
  },
  {
    id: 'p2', externalId: '9', name: 'Test Grouped Bundle', sku: null,
    type: 'grouped', priceMinor: 8000, status: 'publish',
    permalink: null, imageUrl: null,
  },
];

async function show(value: AuthoringSet, products: unknown[] = []) {
  const { render } = await import('@testing-library/react');

  return render(<SetPreview set={value} products={products as never} />);
}

describe('SetPreview — interactive', () => {
  /**
   * 🔴 **The whole milestone in one test.** Choosing `Gold` answers `finish`,
   * a rule reading that condition fires, and the option it targets leaves the
   * page — exactly as it would leave the storefront's markup.
   */
  it('fires a rule when a customer chooses a value', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({ id: 'o2', key: 'engraving', label: 'Engraving Text' }),
        ],
        [rule({ conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }] })],
      ),
    );

    expect(screen.queryByText('Engraving Text')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    /* Absent, not dimmed: the storefront does not render a hidden option. */
    expect(screen.queryByText('Engraving Text')).toBeNull();
  });

  /** The control: without the choice, the rule stays quiet. */
  it('leaves the rule dormant until its condition holds', async () => {
    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({ id: 'o2', key: 'engraving', label: 'Engraving Text' }),
        ],
        [rule({ conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }] })],
      ),
    );

    expect(screen.queryByText('Engraving Text')).not.toBeNull();
  });

  it('marks the chosen value as pressed', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(set([option({ values: [value()] })]));
    const button = screen.getByRole('button', { name: /Gold/ });

    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);

    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  /**
   * 🔴 **`refused` is "cannot be priced", never "no rules applied"** (ADR-050).
   * A cascade deeper than `MAX_RULE_PASSES` never settles, so the storefront
   * refuses the line — and a preview drawing the set as if nothing happened
   * would show a merchant a product no customer can buy.
   *
   * ✏️ **A first version used two rules that "undo each other" and did not
   * refuse** — measured, that pair settles in two passes. The shared fixture's
   * own refusing case is named *"a cascade deeper than the pass limit"*, and a
   * chain is what this builds.
   */
  it('says the rules could not be resolved rather than drawing the set', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const chain = Array.from({ length: 13 }, (_, index) =>
      rule({
        id: `r${index}`,
        targetId: `o${index + 2}`,
        action: 'hide',
        conditions: [
          {
            optionId: `o${index + 1}`,
            /*
             * One `is_not_empty` seed, then `is_empty` all the way down —
             * the shape of the fixture's own refusing case. Each hide clears an
             * answer, so the next rule's condition becomes true on the following
             * pass and the cascade advances exactly one option per pass.
             *
             * ✏️ **Alternating the operators did not refuse**, measured: it
             * breaks the chain, and the whole thing settles early.
             */
            operator: index === 0 ? 'is_not_empty' : 'is_empty',
          },
        ],
        sortOrder: index * 10,
      }),
    );

    /*
     * 🔴 **Every option in the chain is a `hidden` type with a default.**
     *
     * ✏️ **Measured twice before this worked.** The cascade only advances one
     * pass at a time if every option *starts* answered: with `o2…` unanswered,
     * every `is_empty` is true from the first pass and the whole chain settles
     * at once — `passes: 1, refused: null`. The shared fixture seeds all
     * thirteen answers for exactly this reason.
     *
     * A `hidden` option answers itself from `default_value`
     * (`evaluableAnswers`), which is how a *rendered* preview reaches the same
     * starting state a fixture sets by hand.
     */
    const options = [
      option({ id: 'o1', values: [value()] }),
      ...Array.from({ length: 14 }, (_, index) =>
        option({
          id: `o${index + 2}`,
          key: `k${index}`,
          label: `Option ${index + 2}`,
          presentation: 'hidden',
          defaultValue: 'x',
        }),
      ),
    ];

    const screen = await show(set(options, chain));

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.queryByText(/could not be resolved/)).not.toBeNull();
  });

  /**
   * 🔴 **Two rules setting different prices is a refusal, not a winner.** There
   * is no principled choice between 5.00 and 7.00, and picking one would make
   * the amount depend on the order the rules happen to arrive in. ADR-052
   * refuses the pair at publish; this is what a merchant sees if one reaches the
   * preview anyway (AC4).
   *
   * ✏️ **Added because a mutation survived.** Silencing the conflict message
   * broke no test — so the one state a merchant most needs explained was
   * unguarded.
   */
  it('says two rules conflict rather than picking one of their prices', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({ id: 'o2', key: 'engraving', label: 'Engraving Text' }),
        ],
        [
          rule({
            id: 'r1', targetId: 'o2', action: 'set_price',
            actionValue: { amountMinor: 500 },
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
          rule({
            id: 'r2', targetId: 'o2', action: 'set_price',
            actionValue: { amountMinor: 700 },
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
            sortOrder: 10,
          }),
        ],
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.queryByText(/Two rules set different prices/)).not.toBeNull();
  });

  /**
   * The control: one rule setting a price states it, so the test above cannot
   * pass against a preview that simply never reports a price at all.
   */
  it('states a price a single rule sets', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({ id: 'o2', key: 'engraving', label: 'Engraving Text' }),
        ],
        [
          rule({
            id: 'r1', targetId: 'o2', action: 'set_price',
            actionValue: { amountMinor: 500 },
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
        ],
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.queryByText(/A rule sets this to 5\.00/)).not.toBeNull();
  });

  /**
   * 🔴 **F21 — a rule hiding a GROUP hides every option inside it.**
   *
   * The evaluator reports state for the group id only; the options inside carry
   * none. A preview reading option states alone drew the whole group, so a
   * merchant testing a group rule watched it do **nothing** and would have
   * rewritten a rule that was correct.
   */
  it('hides every option inside a group a rule hides', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show({
      id: 's1', storeId: 'store', name: 'Set', status: 'draft', version: 1, rowVersion: 1,
      publishedAt: null, publishedConfigVersion: 0,
      groups: [
        {
          id: 'g1', label: 'Materials', description: null, sortOrder: 0, isEnabled: true,
          displayType: 'inline', isCollapsible: false, items: [],
          options: [option({ values: [value()] })],
        },
        {
          id: 'g2', label: 'Extras', description: null, sortOrder: 1, isEnabled: true,
          displayType: 'inline', isCollapsible: false, items: [],
          options: [option({ id: 'o2', key: 'engraving', label: 'Engraving Text' })],
        },
      ],
      rules: [
        rule({
          targetType: 'group', targetId: 'g2', action: 'hide',
          conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
        }),
      ],
    } as unknown as AuthoringSet);

    expect(screen.queryByText('Engraving Text')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.queryByText('Engraving Text')).toBeNull();
  });

  /**
   * 🔴 **F22 — a rule hiding a VALUE removes that value alone.**
   *
   * Not its option, and not its siblings: hiding one colour of five removes a
   * *choice*, and the question stays on the page (M17.8).
   */
  it('hides a single value without hiding its option', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({
            id: 'o2', key: 'colour', label: 'Colour',
            values: [
              { ...value({ id: 'v2', valueKey: 'red', label: 'Red' }) },
              { ...value({ id: 'v3', valueKey: 'blue', label: 'Blue' }) },
            ],
          }),
        ],
        [
          rule({
            targetType: 'value', targetId: 'v2', action: 'hide',
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
        ],
      ),
    );

    expect(screen.queryByText('Red')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    /* The choice is gone; the question, and its sibling, remain. */
    expect(screen.queryByText('Red')).toBeNull();
    expect(screen.queryByText('Blue')).not.toBeNull();
    expect(screen.queryByText('Colour')).not.toBeNull();
  });

  /**
   * 🔴 **F23 — a rule setting a price on a VALUE overrides its option's.**
   * `SelectionResolver::set_price_for()` prefers the value's `price_minor`, so a
   * preview reading only the option's state shows a price the server will not
   * charge.
   *
   * ⚠️ **`set_price` is not offered by the rule builder** (ADR-054's question is
   * open), but the API accepts one, so a rule can arrive by import — and a
   * published document is input rather than authority (AC4).
   *
   * ✏️ **Added because the fix survived at the component level.** The helper's
   * own suite covered it; nothing proved the component passed the value's state
   * in.
   */
  it('prefers a price a rule set on a value over one set on its option', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({
            id: 'o2', key: 'colour', label: 'Colour',
            values: [value({ id: 'v2', valueKey: 'red', label: 'Red' })],
          }),
        ],
        [
          rule({
            id: 'r1', targetId: 'o2', action: 'set_price',
            actionValue: { amountMinor: 500 },
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
          rule({
            id: 'r2', targetType: 'value', targetId: 'v2', action: 'set_price',
            actionValue: { amountMinor: 900 }, sortOrder: 10,
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
        ],
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.queryByText(/A rule sets this to 9\.00/)).not.toBeNull();
    expect(screen.queryByText(/A rule sets this to 5\.00/)).toBeNull();
  });

  describe('width frame (M21.2)', () => {
    /**
     * 🔴 **The frame resizes; the markup does not change** (ADR-108). The
     * storefront ships no `@media` queries, so three presets constrain the
     * *container* and the choice grid reacts to the space it is given — exactly
     * as it does inside a theme's product column.
     */
    it('offers the three widths and starts on desktop', async () => {
      const screen = await show(set([option({ values: [value()] })]));

      expect(screen.getByRole('button', { name: 'Phone' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Tablet' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Desktop' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    it('narrows the frame when a merchant picks the phone width', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(set([option({ values: [value()] })]));

      fireEvent.click(screen.getByRole('button', { name: 'Phone' }));

      expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(screen.container.innerHTML).toContain('max-width: 23.4rem');
    });

    /**
     * ⚠️ **The options inside are untouched by the width.** A preview that
     * re-rendered different markup per width would be inventing breakpoints the
     * storefront does not have.
     */
    it('changes nothing about the options themselves', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set([option({ display: { columns: 4 }, values: [value()] })]),
      );

      const before = screen.container.innerHTML.includes('repeat(auto-fit, minmax(7em, 1fr))');

      fireEvent.click(screen.getByRole('button', { name: 'Phone' }));

      expect(screen.container.innerHTML.includes('repeat(auto-fit, minmax(7em, 1fr))')).toBe(
        before,
      );
    });
  });

  describe('the base price (M21.4)', () => {
    /**
     * 🔴 **The whole milestone: a real product's price changes the numbers.**
     * 2.5% of the £50 sample is £1.25; of a real £100 product it is £2.50. A
     * merchant pricing a percentage option against an invented base is
     * reasoning about the wrong product.
     */
    it('reprices against the product a merchant chooses', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set([
          option({
            values: [
              value({
                priceType: 'percentage',
                priceConfig: { type: 'percentage', basisPoints: 250 },
              }),
            ],
          }),
        ]),
        PRODUCTS,
      );

      expect(screen.queryByText('+1.25')).not.toBeNull();

      fireEvent.change(screen.getByRole('combobox', { name: 'Price against' }), { target: { value: 'p1' } });

      expect(screen.queryByText('+2.50')).not.toBeNull();
      expect(screen.queryByText('+1.25')).toBeNull();
    });

    /**
     * ⚠️ **"as last synced" is load-bearing.** `StoreProduct` is display-only —
     * *"a cached price shown at checkout would be a customer charged the wrong
     * amount"* — and the catalogue is push-driven, so the cloud cannot fetch a
     * fresher number. The preview may mirror; it may not imply a live quote.
     */
    it('says the price is a mirror of the last sync', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(set([option({ values: [value()] })]), PRODUCTS);

      fireEvent.change(screen.getByRole('combobox', { name: 'Price against' }), { target: { value: 'p1' } });

      expect(screen.queryByText(/as last synced from your store/)).not.toBeNull();
    });

    /**
     * 🔴 **F31 — the catalogue pushes every type; the storefront renders two.**
     * A merchant pricing against a `grouped` product would see a full preview
     * and their customer would see nothing at all.
     */
    it('warns when the chosen product would render no options', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(set([option({ values: [value()] })]), PRODUCTS);

      expect(screen.queryByText(/would see none of this/)).toBeNull();

      fireEvent.change(screen.getByRole('combobox', { name: 'Price against' }), { target: { value: 'p2' } });

      expect(screen.queryByText(/would see none of this/)).not.toBeNull();
    });

    it('goes back to the stated sample when the merchant clears the choice', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(set([option({ values: [value()] })]), PRODUCTS);

      fireEvent.change(screen.getByRole('combobox', { name: 'Price against' }), { target: { value: 'p1' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Price against' }), { target: { value: '' } });

      expect(screen.queryByText(/a sample product price of 50\.00/)).not.toBeNull();
    });
  });

  describe('answering an option that carries no values (F32)', () => {
    /**
     * 🔴 **The commonest conditional pattern there is.** A rule reading
     * *"engraving text is not empty"* could never fire in the preview: every
     * control was inert, so the merchant had nothing to type into, the condition
     * stayed false, and a correct rule looked broken.
     */
    it('fires a rule when a customer types into a text option', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set(
          [
            option({ id: 'o1', key: 'engraving', label: 'Engraving Text', presentation: 'text_field' }),
            option({ id: 'o2', key: 'wrap', label: 'Gift Wrap' }),
          ],
          [
            rule({
              targetId: 'o2', action: 'hide',
              conditions: [{ optionId: 'o1', operator: 'is_not_empty' }],
            }),
          ],
        ),
      );

      expect(screen.queryByText('Gift Wrap')).not.toBeNull();

      fireEvent.change(screen.getByLabelText('Engraving Text'), {
        target: { value: 'Hello' },
      });

      expect(screen.queryByText('Gift Wrap')).toBeNull();
    });

    it.each([
      ['number_field', 'number'],
      ['date_picker', 'date'],
      ['time_picker', 'time'],
      ['datetime_picker', 'datetime-local'],
    ])('gives a %s a real %s control', async (presentation, type) => {
      const screen = await show(set([option({ label: 'Pick', presentation })]));

      expect(screen.getByLabelText('Pick').getAttribute('type')).toBe(type);
    });

    /** `hidden` answers itself; a file a customer has not uploaded cannot be invented. */
    it.each(['hidden', 'file_input'])('leaves %s without a customer control', async (presentation) => {
      const screen = await show(set([option({ label: 'Batch', presentation })]));

      expect(screen.queryByLabelText('Batch')).toBeNull();
    });
  });

  describe('option-level pricing (F33)', () => {
    /**
     * 🔴 **Nothing showed this anywhere** — not the preview, not M20.6's worked
     * example — while the server charged it and nine shared fixture cases pinned
     * the arithmetic. £0.25 × 5 characters is £1.25.
     */
    it('charges per character for what the customer typed', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set([
          option({
            label: 'Engraving Text',
            presentation: 'text_field',
            pricing: { type: 'per_char', amountMinor: 25, freeCharacters: 0 },
          }),
        ]),
      );

      fireEvent.change(screen.getByLabelText('Engraving Text'), {
        target: { value: 'HELLO' },
      });

      expect(screen.queryByText(/\+1\.25 for what you have entered/)).not.toBeNull();
    });

    /** An unanswered field costs nothing, which is what the server charges too. */
    it('says nothing before the customer has typed', async () => {
      const screen = await show(
        set([
          option({
            label: 'Engraving Text',
            presentation: 'text_field',
            pricing: { type: 'per_char', amountMinor: 25, freeCharacters: 0 },
          }),
        ]),
      );

      expect(screen.queryByText(/for what you have entered/)).toBeNull();
    });

    it('honours free characters before charging', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set([
          option({
            label: 'Engraving Text',
            presentation: 'text_field',
            pricing: { type: 'per_char', amountMinor: 25, freeCharacters: 3 },
          }),
        ]),
      );

      fireEvent.change(screen.getByLabelText('Engraving Text'), {
        target: { value: 'HELLO' },
      });

      /* Five characters, three free, two charged. */
      expect(screen.queryByText(/\+0\.50 for what you have entered/)).not.toBeNull();
    });
  });

  describe('field constraints (F34)', () => {
    /**
     * 🔴 **The preview read one of seventeen validation keys.** A merchant
     * setting min 1 / max 100 on a quantity saw no constraint at all, while the
     * storefront emits real HTML attributes a browser acts on — verified against
     * `rendered-fixtures.json`, where a `number_field` carries `min`, `max` and
     * `required`.
     */
    it('gives a number field the bounds the storefront emits', async () => {
      const screen = await show(
        set([
          option({
            label: 'How many',
            presentation: 'number_field',
            validation: { min: 1, max: 100, step: 5 },
          }),
        ]),
      );

      const field = screen.getByLabelText('How many');

      expect(field.getAttribute('min')).toBe('1');
      expect(field.getAttribute('max')).toBe('100');
      expect(field.getAttribute('step')).toBe('5');
    });

    /** `integer_only` is expressed to a browser as `step="1"`. */
    it('expresses integer_only as a step of one', async () => {
      const screen = await show(
        set([
          option({
            label: 'How many',
            presentation: 'number_field',
            validation: { integerOnly: true },
          }),
        ]),
      );

      expect(screen.getByLabelText('How many').getAttribute('step')).toBe('1');
    });

    it('keeps a length limit on a text field', async () => {
      const screen = await show(
        set([
          option({
            label: 'Engraving Text',
            presentation: 'text_field',
            validation: { maxLength: 20 },
          }),
        ]),
      );

      expect(screen.getByLabelText('Engraving Text').getAttribute('maxlength')).toBe('20');
    });

    /**
     * 🔴 **F37 — a quantity always steps by one**, whatever the merchant set,
     * because a quantity is inherently whole. `number_field` and `range` only
     * step when told to.
     */
    it('steps a quantity by one with no rule set', async () => {
      const screen = await show(
        set([option({ label: 'How many', presentation: 'quantity' })]),
      );

      expect(screen.getByLabelText('How many').getAttribute('step')).toBe('1');
    });

    it('leaves a number field unstepped with no rule set', async () => {
      const screen = await show(
        set([option({ label: 'How many', presentation: 'number_field' })]),
      );

      expect(screen.getByLabelText('How many').getAttribute('step')).toBeNull();
    });

    /**
     * 🔴 **F38 — a range is a slider, not a spinbox.** The storefront renders
     * `type="range"` with an `<output>` readout beside it.
     *
     * ✏️ **Making the preview answerable regressed this**: the inert
     * `OptionPreview` it replaced had always drawn a real slider, and the values
     * agreed, so ADR-109's numbers-only comparison would have certified it
     * exact.
     */
    it('draws a range as a slider with its value read out', async () => {
      const { fireEvent } = await import('@testing-library/react');

      const screen = await show(
        set([
          option({
            label: 'How long',
            presentation: 'range',
            validation: { min: 10, max: 50, step: 5 },
          }),
        ]),
      );

      const field = screen.getByLabelText('How long');

      expect(field.getAttribute('type')).toBe('range');

      fireEvent.change(field, { target: { value: '25' } });

      expect(screen.container.querySelector('output')?.textContent).toBe('25');
    });

    /**
     * ⚠️ **Selection and date bounds are server-enforced only.** No template
     * emits them, so a preview that did would show a customer a limit their
     * browser will not apply — a disagreement in the direction that matters
     * most.
     */
    it('invents no limit the storefront does not send to a browser', async () => {
      const screen = await show(
        set([
          option({
            label: 'When',
            presentation: 'date_picker',
            validation: { minDate: '2026-01-01', maxDate: '2026-12-31' },
          }),
        ]),
      );

      const field = screen.getByLabelText('When');

      expect(field.getAttribute('min')).toBeNull();
      expect(field.getAttribute('max')).toBeNull();
    });
  });

  /** A rule may require an option the merchant left optional. */
  it('applies a rule that makes an option required', async () => {
    const { fireEvent } = await import('@testing-library/react');

    const screen = await show(
      set(
        [
          option({ values: [value()] }),
          option({ id: 'o2', key: 'engraving', label: 'Engraving Text' }),
        ],
        [
          rule({
            action: 'require',
            conditions: [{ optionId: 'o1', operator: 'equals', value: 'gold' }],
          }),
        ],
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Gold/ }));

    expect(screen.getByText('Engraving Text').closest('div')?.textContent).toContain('*');
  });
});
