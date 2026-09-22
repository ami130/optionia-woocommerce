import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';
import { findType, isRegistered, registeredTypes } from './type-registry';

/**
 * The registry.
 *
 * M7.3 asks for `radio` only, built so **Phase 14 is registration, not
 * refactoring**. These tests are as much about that property as about radio: a
 * registry that happens to hold one entry and a registry that can hold twelve
 * look identical until someone adds the second.
 */
/**
 * What each registered type must be, asserted per type.
 *
 * 🔴 **A table, because the per-type version did not scale past one.** Phase 7
 * wrote `registers radio` by hand and guarded radio's axes with it. Phase 14
 * added `dropdown` and wrote no equivalent — measured by mutation: corrupting
 * **radio's** axes to `text`/`none` failed 4 tests, and corrupting **dropdown's**
 * passed all 631. The new type had no protection at all.
 *
 * The axes are not decoration. `valueKind` and `cardinality` decide whether
 * `SelectionResolver` looks a value up in a set, whether the editor shows a value
 * list, and whether pricing is per-value — so a wrong pair here is a broken type
 * everywhere, silently.
 *
 * Adding a row is now the cost of adding a type, and forgetting the row is a
 * failure rather than a silence: `covers every registered type` below refuses a
 * registry entry this table does not describe.
 */
const EXPECTED_AXES = [
  {
    presentation: Presentation.RADIO,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
  },
  {
    presentation: Presentation.DROPDOWN,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
  },
  /*
   * ✅ **`checkbox` gained `MANY` in M18.3; the two swatches did not.**
   *
   * This assertion is what stopped `MANY` being added quietly, and it did its
   * job — widening the registry before the array path existed would have let
   * the API accept a selection `SelectionResolver` refused. It now records the
   * widening instead of forbidding it, and still forbids the other two.
   *
   * 🔴 **`ONE` must stay FIRST.** `OptionsService.create()` defaults to
   * `cardinality[0]`, so reordering this array would silently turn every new
   * checkbox into a multi-select. The order is asserted, not just the members.
   */
  {
    presentation: Presentation.CHECKBOX,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE, Cardinality.MANY],
    takesValues: true,
  },
  {
    presentation: Presentation.COLOR_SWATCH,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
  },
  {
    presentation: Presentation.IMAGE_SWATCH,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
  },
  /*
   * 🔴 **The only row with `takesValues: false`, and the only non-`choice` kind.**
   *
   * Both matter. `takesValues` decides whether an option with no values is a
   * publish blocker or the normal case, and it is the single field the dashboard
   * reads to decide whether to offer an "add value" form at all — so a row that
   * asserted `true` here would pass while the product was wrong in two places.
   *
   * `[NONE]` rather than `[ONE]`: a text option produces one string, not one
   * selection from a set, and the axes exist to describe what the resolver
   * actually does.
   */
  {
    presentation: Presentation.TEXT_FIELD,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  /*
   * ⚠️ **Identical axes to `text_field`, deliberately.**
   *
   * Two entries agreeing on every field is what the three-axis model looks like
   * when it is working: the axes carry behaviour, the presentation carries
   * rendering, and the *only* difference between these two is whether a newline
   * survives the resolver.
   */
  {
    presentation: Presentation.TEXTAREA,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  /*
   * 🔴 **The first row whose `valueKind` is neither `choice` nor `text`.**
   *
   * A number has an ordering, so its validation bounds the *value* rather than
   * its length — the reason it cannot share `textValidationSchema`.
   */
  {
    presentation: Presentation.NUMBER_FIELD,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  /*
   * ⚠️ **Three rows now share `number`/`none`/no values.**
   *
   * `number_field`, `range` and `quantity` differ only in the control a customer
   * meets — which is exactly what `presentation` carries. The axes being
   * identical is the model working, not duplication: the resolver needs no new
   * branch for either, because a slider's answer is a number like any other.
   */
  {
    presentation: Presentation.RANGE,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  {
    presentation: Presentation.QUANTITY,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  /*
   * ⚠️ **Three rows sharing `date`, differing only in precision.**
   *
   * `value_kind` cannot express whether a value carries a day, a time, or both
   * — so the resolver reads the *presentation* for that one decision, exactly as
   * it does for `textarea`'s line breaks.
   */
  {
    presentation: Presentation.DATE_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  {
    presentation: Presentation.TIME_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  {
    presentation: Presentation.DATETIME_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
  /*
   * 🔴 **`text`, but the customer never supplies it.**
   *
   * A hidden field's value comes from `defaultValue` and the resolver ignores
   * what is posted — hidden from the *page* is not hidden from the customer.
   */
  {
    presentation: Presentation.HIDDEN,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },

  /**
   * A file the customer uploads (M15.2).
   *
   * ⚠️ **`NONE`, not `ONE`** — the same reasoning as `text_field`: the customer
   * supplies a value rather than choosing from a set the merchant authored, so
   * there is nothing to have "one of". Multi-file is `MANY`, and no type has
   * ever used it: `Engine\SelectionResolver` refuses non-scalar selections, so
   * the array path through resolver, cart, labels and order has to exist first.
   */
  {
    presentation: Presentation.FILE_INPUT,
    valueKind: ValueKind.FILE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
  },
] as const;

describe('type registry', () => {
  it.each(EXPECTED_AXES)('registers $presentation with the right axes', (expected) => {
    const type = findType(expected.presentation);

    expect(type).not.toBeNull();
    expect(type?.valueKind).toBe(expected.valueKind);
    expect(type?.cardinality).toEqual(expected.cardinality);
    expect(type?.takesValues).toBe(expected.takesValues);
  });

  /**
   * ⚠️ **The table must describe every entry, or it protects only what it lists.**
   * Without this, registering a type and forgetting its row leaves that type
   * exactly as unguarded as `dropdown` was — which is the gap this whole block
   * exists to close.
   */
  it('covers every registered type', () => {
    const described = new Set(EXPECTED_AXES.map((axes) => axes.presentation));

    registeredTypes().forEach((type) => {
      expect(described.has(type.presentation as (typeof EXPECTED_AXES)[number]['presentation'])).toBe(
        true,
      );
    });
  });

  /**
   * Scope discipline, asserted rather than assumed. Phase 7 ships one type; a
   * second appearing here early is scope creep the milestone refuses.
   *
   * ⚠️ **This is a Phase 7 tripwire, and Phase 14 is when it fires.** Registering
   * a second type *should* break it — that is the whole design, the same device
   * as Phase 8's 60-second handoff test. When it does, raise the number as part
   * of accepting the new type; **do not delete it**, or the next phase inherits a
   * registry nothing counts.
   *
   * ✏️ **Raised 1 → 2 → 5 on 2026-09-03**, accepting `dropdown`, then
   * `checkbox`, `color_swatch` and `image_swatch`. Kept as a count rather than
   * loosened to `toBeGreaterThan`: a number that only ever rises is a number
   * nobody has to think about, and thinking about it is the entire job of this
   * assertion.
   */
  it('registers exactly the types this phase has accepted', () => {
    expect(registeredTypes()).toHaveLength(15);
  });

  /**
   * Null rather than a throw: an unregistered presentation is caller input, and
   * a throw would turn a typo in a request body into a 500.
   *
   * ✏️ **The moving target has run out, and that is the news.** This assertion
   * named whichever presentation was still unregistered — `DROPDOWN`, then
   * `CHECKBOX`, `TEXT_FIELD`, `TEXTAREA`, `RANGE`, and finally `FILE_INPUT` —
   * with each edit swapping in the next. Phase 15 registers the last one, so
   * **every member of `Presentation` is now registered** and there is nothing
   * left to swap.
   *
   * The assertion therefore changes shape rather than being deleted: an unknown
   * *string* still has to answer `null`, which is the behaviour that actually
   * protects the route. A typo in a request body must not become a 500, and that
   * is true whether or not any presentation is pending.
   */
  it('returns null for a type that is not registered', () => {
    expect(findType('not-a-type')).toBeNull();
    expect(findType('')).toBeNull();
    expect(isRegistered('not-a-type')).toBe(false);
  });

  /**
   * Every entry must carry all three schemas. A type registered without one
   * would validate nothing for that column while looking complete.
   */
  it('gives every registered type all three schemas', () => {
    registeredTypes().forEach((type) => {
      expect(type.validationSchema).toBeDefined();
      expect(type.displaySchema).toBeDefined();
      expect(type.pricingSchema).toBeDefined();
    });
  });

  /**
   * The registry keys on presentation because of the three-axis model (M5.4b):
   * radio and dropdown are the same choice/one pair rendered differently.
   */
  it('keys on presentation, and every key is a real presentation', () => {
    const valid = new Set<string>(Object.values(Presentation));

    registeredTypes().forEach((type) => {
      expect(valid.has(type.presentation)).toBe(true);
    });
  });

  /**
   * 🔴 **W1: the other direction — which presentations exist only as a name.**
   *
   * The forward check above proves the registry invents nothing. It says nothing
   * about the reverse, and the reverse is where the gap is: `Presentation`
   * declares **eleven** values, the registry holds **one**, and the column is
   * `varchar(30)` with no constraint. The enum reads as a feature list while ten
   * of those features do not exist.
   *
   * Safe — every layer fails closed, and `assertValidOption` answers
   * `UNSUPPORTED_OPTION_TYPE` naming what *is* supported. But safe and invisible
   * is how a gap survives: this names the shortfall so it shrinks visibly as
   * Phase 14 registers each type, rather than being rediscovered.
   *
   * ⚠️ **This is not a ceiling.** It asserts the *set*, not a count, so
   * registering a type is a one-line edit here and the assertion keeps meaning
   * the same thing.
   */
  it('names every presentation that is declared but not yet registered', () => {
    const registered = new Set(registeredTypes().map((type) => type.presentation));

    const unregistered = Object.values(Presentation)
      .filter((presentation) => !registered.has(presentation))
      .sort();

    /*
     * ✏️ **The list is now empty, and that is what this assertion was built to
     * show.** It began at eleven — `CHECKBOX`, `COLOR_SWATCH`, `DROPDOWN`,
     * `IMAGE_SWATCH`, `TEXT_FIELD`, `TEXTAREA`, `NUMBER_FIELD`, `RANGE`,
     * `QUANTITY` and the three date types left it as Phase 14 registered them,
     * and `FILE_INPUT` leaves it here in Phase 15.
     *
     * ⚠️ **Kept, not deleted, and asserting empty is stronger than asserting a
     * name.** The invariant it now guards is that `Presentation` and the registry
     * agree completely: adding a member to the enum without registering it fails
     * here immediately, rather than being discovered when a merchant picks a type
     * the API refuses. That is a better guarantee than the shrinking list ever
     * gave, and it only becomes available once the list reaches zero.
     */
    expect(unregistered).toEqual([]);
  });

  describe('radio validation schema', () => {
    const radio = findType(Presentation.RADIO);

    it('accepts an empty object', () => {
      expect(radio?.validationSchema.safeParse({}).success).toBe(true);
    });

    it('accepts sane selection bounds', () => {
      expect(
        radio?.validationSchema.safeParse({ minSelections: 1, maxSelections: 1 }).success,
      ).toBe(true);
    });

    it('rejects a minimum above the maximum', () => {
      const result = radio?.validationSchema.safeParse({ minSelections: 3, maxSelections: 1 });

      expect(result?.success).toBe(false);
      expect(result?.error?.issues[0].message).toMatch(/exceeds the maximum/);
    });

    /**
     * Strict, so a typo is an error rather than a silently ignored field. A
     * merchant who writes `maxSelection` and sees it accepted will assume it
     * works.
     */
    it('rejects an unknown field rather than ignoring it', () => {
      const result = radio?.validationSchema.safeParse({ maxSelection: 2 });

      expect(result?.success).toBe(false);
    });
  });

  describe('radio display schema', () => {
    const radio = findType(Presentation.RADIO);

    it('accepts the documented options', () => {
      expect(
        radio?.displaySchema.safeParse({
          columns: 3,
          priceDisplay: 'delta',
          swatchSize: 'medium',
        }).success,
      ).toBe(true);
    });

    it('rejects an out-of-range column count', () => {
      expect(radio?.displaySchema.safeParse({ columns: 0 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ columns: 99 }).success).toBe(false);
    });

    it('rejects an unknown price framing', () => {
      expect(radio?.displaySchema.safeParse({ priceDisplay: 'sideways' }).success).toBe(false);
    });

    /**
     * ✏️ **`labelPlacement` and `showPriceDelta` were withdrawn in M18.6a**
     * (ADR-064), so the schema must now refuse them rather than accept them
     * unread. `.strict()` is what turns a withdrawal into a refusal instead of
     * a silently ignored field.
     */
    it('refuses the two withdrawn display fields', () => {
      expect(radio?.displaySchema.safeParse({ labelPlacement: 'above' }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ showPriceDelta: true }).success).toBe(false);
    });

    /*
     * -------------------------------------------------------------------
     * The four style tokens (M21c.2, ADR-112)
     *
     * 🔴 **These become CSS on a merchant's storefront**, so the schema is the
     * first of two defences — the plugin re-validates at emission (M21c.4).
     * What is tested here is that a bad value never becomes an authored one.
     * -------------------------------------------------------------------
     */
    it('accepts the four style tokens', () => {
      expect(
        radio?.displaySchema.safeParse({
          accentColor: '#3858e9',
          borderRadius: 4,
          spacing: 12,
          swatchPx: 48,
        }).success,
      ).toBe(true);
    });

    /**
     * 🔴 **The injection case.** An accent colour reaches a `style` attribute,
     * so anything that is not six hex digits must not survive authoring —
     * a closing quote and a second declaration most of all.
     */
    it('rejects an accent colour that is not six hex digits', () => {
      for (const hostile of [
        '#f00',
        'red',
        'rgb(255,0,0)',
        '#3858e9; background: url(//evil)',
        '#3858e9"',
        'var(--x)',
        '#gggggg',
        '',
      ]) {
        expect(radio?.displaySchema.safeParse({ accentColor: hostile }).success).toBe(false);
      }
    });

    it('clamps the three numeric tokens to their documented ranges', () => {
      expect(radio?.displaySchema.safeParse({ borderRadius: -1 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ borderRadius: 25 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ spacing: -1 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ spacing: 49 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ swatchPx: 15 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ swatchPx: 129 }).success).toBe(false);
    });

    /**
     * ⚠️ **A float is not a pixel count.** `4.5` would reach a stylesheet as
     * `4.5px`, which renders — so the refusal has to be the schema's, not the
     * renderer's.
     */
    it('rejects a fractional pixel value', () => {
      expect(radio?.displaySchema.safeParse({ borderRadius: 4.5 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ spacing: 0.5 }).success).toBe(false);
    });

    /**
     * ⚠️ **A number arriving as a string is still not a number.** The wire is
     * JSON and a dashboard field is a text input; `"4"` is what a form sends
     * when nobody coerced it.
     */
    it('rejects a numeric token sent as a string', () => {
      expect(radio?.displaySchema.safeParse({ borderRadius: '4' }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ swatchPx: '48' }).success).toBe(false);
    });

    /**
     * 🔴 **The tokens are shared, so both display schemas must carry them.**
     * They are spread from one definition precisely so a merchant learns the
     * vocabulary once — a text field has an accent colour as much as a swatch
     * does, and two copies is how the two come to disagree.
     */
    it('accepts the style tokens on a text option too', () => {
      const text = findType(Presentation.TEXT_FIELD);

      expect(
        text?.displaySchema.safeParse({
          accentColor: '#3858e9',
          borderRadius: 4,
          spacing: 12,
        }).success,
      ).toBe(true);

      expect(text?.displaySchema.safeParse({ accentColor: 'red' }).success).toBe(false);
    });
  });

  describe('radio pricing schema', () => {
    const radio = findType(Presentation.RADIO);

    /**
     * A radio prices per value. A type-level amount would be charged *in
     * addition* to the selected value's price, silently doubling every priced
     * option — so it is refused rather than accepted and ignored.
     */
    it('refuses type-level pricing', () => {
      expect(radio?.pricingSchema.safeParse({ type: 'fixed', amountMinor: 100 }).success).toBe(
        false,
      );
    });

    it('accepts null', () => {
      expect(radio?.pricingSchema.safeParse(null).success).toBe(true);
    });
  });

  /**
   * 🔴 Which option types may carry `per_char`, and which may not.
   *
   * M16.2 built the evaluator, the shared fixture, the document converter and
   * the contract — and every option type still carried `noTypeLevelPricing`, so
   * **a merchant could not save a `per_char` price at all**. The feature was
   * unreachable while every test passed, because they all exercised code behind
   * this gate.
   *
   * Lifting it alone would have been worse. `option_delta()` dispatches on
   * `pricing.type` and has no view of what kind of answer an option produces, so
   * with the gate open and no restriction:
   *
   * ```text
   * per_char on a FILE option   -> a 64-character upload token -> 32.00
   * per_char on a DATE option   -> "2026-10-01"                ->  5.00
   * ```
   *
   * `hidden` is the subtle exclusion: its value kind IS text, but its value is
   * the merchant's own `default_value` and never customer input.
   */
  describe('per_char is accepted only where a customer types', () => {
    const perChar = { type: 'per_char', amountMinor: 50, freeCharacters: 0 };

    it.each([Presentation.TEXT_FIELD, Presentation.TEXTAREA])('accepts it on %s', (which) => {
      expect(findType(which)?.pricingSchema.safeParse(perChar).success).toBe(true);
    });

    it.each([
      Presentation.HIDDEN,
      Presentation.FILE_INPUT,
      Presentation.DATE_PICKER,
      Presentation.NUMBER_FIELD,
      Presentation.RADIO,
    ])('refuses it on %s', (which) => {
      expect(findType(which)?.pricingSchema.safeParse(perChar).success).toBe(false);
    });

    /**
     * A text option prices per character or not at all.
     *
     * Every other type is defined at the **value** level, so accepting one here
     * would let a merchant configure a price the evaluator reports as unpriced —
     * a silent undercharge that looks like a saved setting.
     */
    it.each(['fixed', 'percentage', 'per_unit', 'tiered'])(
      'refuses %s even on a text option',
      (type) => {
        const config = { type, amountMinor: 50 };

        expect(findType(Presentation.TEXT_FIELD)?.pricingSchema.safeParse(config).success).toBe(
          false,
        );
      },
    );

    /** Most text options are free, so null must stay valid. */
    it('accepts null, because most text options are free', () => {
      expect(findType(Presentation.TEXT_FIELD)?.pricingSchema.safeParse(null).success).toBe(true);
    });
  });

  /**
   * 🔴 Which option types may carry `per_unit`, and which may not.
   *
   * The same two-part rule `per_char` needed. The gate had to be lifted — M16.2
   * shipped an evaluator behind a closed registry and the feature was
   * unreachable — and lifting it alone would multiply by whatever answer an
   * option happens to produce: a date's `"2026-10-01"` is not a quantity.
   */
  describe('per_unit is accepted only where an option produces a number', () => {
    const perUnit = { type: 'per_unit', amountMinor: 200 };

    it.each([Presentation.NUMBER_FIELD, Presentation.RANGE, Presentation.QUANTITY])(
      'accepts it on %s',
      (which) => {
        expect(findType(which)?.pricingSchema.safeParse(perUnit).success).toBe(true);
      },
    );

    it.each([
      Presentation.TEXT_FIELD,
      Presentation.TEXTAREA,
      Presentation.DATE_PICKER,
      Presentation.FILE_INPUT,
      Presentation.RADIO,
    ])('refuses it on %s', (which) => {
      expect(findType(which)?.pricingSchema.safeParse(perUnit).success).toBe(false);
    });

    /**
     * A number option prices per unit or not at all. Accepting a value-level
     * type here would let a merchant save a price the evaluator reports as
     * unpriced — a silent undercharge that looks like a saved setting.
     */
    it.each(['fixed', 'percentage', 'per_char', 'tiered'])(
      'refuses %s even on a number option',
      (type) => {
        expect(
          findType(Presentation.NUMBER_FIELD)?.pricingSchema.safeParse({ type, amountMinor: 50 })
            .success,
        ).toBe(false);
      },
    );

    /** Most number options are free, so null must stay valid. */
    it('accepts null, because most number options are free', () => {
      expect(findType(Presentation.NUMBER_FIELD)?.pricingSchema.safeParse(null).success).toBe(true);
    });

    /**
     * ⚠️ No `freeUnits`, deliberately — a free allowance on a quantity is a
     * volume discount, which `tiered` expresses with brackets a merchant can
     * see. Asserted so the asymmetry with `per_char` stays a decision rather
     * than drifting into an oversight someone "fixes".
     */
    it('has no free-unit allowance', () => {
      expect(
        findType(Presentation.NUMBER_FIELD)?.pricingSchema.safeParse({
          ...perUnit,
          freeUnits: 5,
        }).success,
      ).toBe(false);
    });
  });
});
