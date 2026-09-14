import { describe, expect, it } from 'vitest';

import {
  AUTHORABLE_TYPES,
  GROUP_LAYOUTS,
  OPTION_SET_LIMITS,
  createSetSchema,
  groupDisplaySchema,
  groupSchema,
  optionSchema,
  COLUMN_CHOICES,
  acceptsColumns,
  acceptsLength,
  acceptsManyAnswers,
  configFor,
  layoutFor,
  mergeConfig,
  keyFromLabel,
  swatchFieldsFor,
  takesGroupLabel,
  takesValues,
  valueSchema,
} from './option-sets';

const UUID = '0f3c9a1e-4b2d-4c6f-9a11-2e5d7c8b3f04';

describe('option-set schemas', () => {
  /** Copied from the API's DTOs. A drift is a failing test, not a surprised merchant. */
  it('mirrors the API’s documented limits', () => {
    expect({ ...OPTION_SET_LIMITS, KEY_PATTERN: String(OPTION_SET_LIMITS.KEY_PATTERN) }).toEqual({
      MAX_SET_NAME: 255,
      MAX_GROUP_LABEL: 160,
      MAX_GROUP_DESCRIPTION: 2000,
      MAX_OPTION_KEY: 64,
      MAX_OPTION_LABEL: 200,
      MAX_VALUE_KEY: 64,
      MAX_VALUE_LABEL: 200,
      KEY_PATTERN: '/^[a-z0-9][a-z0-9_-]*$/',
    });
  });

  describe('create set', () => {
    it('accepts a name and a store', () => {
      expect(createSetSchema.safeParse({ name: 'Hoodie options', storeId: UUID }).success).toBe(true);
    });

    it.each([
      ['an empty name', { name: '' }],
      ['an over-long name', { name: 'x'.repeat(256) }],
      ['a missing store', { storeId: 'not-a-uuid' }],
    ])('refuses %s', (_label, over) => {
      expect(createSetSchema.safeParse({ name: 'N', storeId: UUID, ...over }).success).toBe(false);
    });
  });

  describe('option key', () => {
    /**
     * 🔴 **The pattern a merchant has no intuition for.**
     *
     * Nothing about "Large Size" announces itself as an invalid key, so the form
     * must say what one may contain before the API answers with a regex.
     */
    it.each([
      ['a space', 'Large Size'],
      ['uppercase', 'Finish'],
      ['a leading hyphen', '-finish'],
      ['a leading underscore', '_finish'],
      ['punctuation', 'finish!'],
      ['empty', ''],
    ])('refuses %s', (_label, value) => {
      expect(optionSchema.safeParse({
        key: value,
        label: 'Finish',
        presentation: 'radio',
        isRequired: true,
      }).success).toBe(false);
    });

    it.each(['finish', 'finish-type', 'finish_type', 'f1', '9lives'])('accepts %s', (value) => {
      expect(optionSchema.safeParse({
        key: value,
        label: 'Finish',
        presentation: 'radio',
        isRequired: true,
      }).success).toBe(true);
    });

    it('explains what a key may contain', () => {
      const result = optionSchema.safeParse({
        key: 'Large Size',
        label: 'L',
        presentation: 'radio',
        isRequired: false,
      });

      expect(result.error?.issues[0].message).toContain('lowercase');
    });
  });

  describe('option', () => {
    /**
     * The API accepts eleven presentations; this editor authors the ones it can
     * also **re-open**. Offering a type before its editor exists would produce
     * sets this UI cannot reopen — a worse failure than a missing type.
     *
     * ✏️ **`dropdown` moved from rejected to accepted on 2026-09-03**, Phase 14's
     * first type. It needs no new editor: same `choice`/`one` axes, same values,
     * same per-value pricing — a merchant authors it identically to `radio`.
     *
     * ⚠️ `text_field` stays rejected **even once the API registers it**. It takes
     * no values, so the value editor beside this form is meaningless for it. The
     * bar for this list is the round trip, not registration.
     */
    it('accepts the types this editor can round-trip', () => {
      const base = { key: 'finish', label: 'Finish', isRequired: false };

      expect(optionSchema.safeParse({ ...base, presentation: 'radio' }).success).toBe(true);
      expect(optionSchema.safeParse({ ...base, presentation: 'dropdown' }).success).toBe(true);
      expect(optionSchema.safeParse({ ...base, presentation: 'checkbox' }).success).toBe(true);

      /*
       * ✏️ The swatches became authorable once the value editor could set a
       * colour or an image — they were rejected here until that field existed,
       * because a merchant could otherwise publish a swatch that renders as a
       * plain radio.
       */
      expect(optionSchema.safeParse({ ...base, presentation: 'color_swatch' }).success).toBe(true);
      expect(optionSchema.safeParse({ ...base, presentation: 'image_swatch' }).success).toBe(true);

      /*
       * ✏️ **`text_field` became authorable once the editor stopped offering a
       * value form for it.**
       *
       * It was rejected here while that form still rendered — a merchant would
       * have been invited to add values the API refuses and the storefront
       * ignores. `takesValues()` now hides it, which is the same bar the
       * swatches cleared: **authorable means author *and* re-open**, with no
       * control on the page that cannot mean anything.
       */
      expect(optionSchema.safeParse({ ...base, presentation: 'text_field' }).success).toBe(true);
      expect(optionSchema.safeParse({ ...base, presentation: 'nonsense' }).success).toBe(false);
    });
  });

  describe('swatch fields', () => {
    /**
     * 🔴 **The two mutants that survived the first attempt.**
     *
     * Setting `needsColor = false` re-creates the exact defect this feature
     * closed — swatches authorable with no way to set a colour, so a merchant
     * publishes something that renders as plain radios. Sending `colorHex` for
     * every type is the opposite error: a radio's values carrying a field they
     * have no use for.
     *
     * Both passed all 319 tests while the rule was inlined in a component no
     * test could reach.
     */
    it('asks a colour swatch for a colour, and nothing else', () => {
      expect(swatchFieldsFor('color_swatch')).toEqual({ color: true, image: false });
    });

    it('asks an image swatch for an image, and nothing else', () => {
      expect(swatchFieldsFor('image_swatch')).toEqual({ color: false, image: true });
    });

    /**
     * Every other type asks for neither — including ones not yet registered.
     *
     * Asking a radio's values for a hex code is noise, and noise is how a form
     * teaches merchants to ignore it. An unknown presentation gets nothing
     * rather than everything, which is the safe direction: a type this editor
     * does not understand should not silently collect fields for it.
     */
    it.each(['radio', 'dropdown', 'checkbox', 'text_field', 'not-a-type', ''])(
      'asks %s for neither',
      (presentation) => {
        expect(swatchFieldsFor(presentation)).toEqual({ color: false, image: false });
      },
    );
  });

  describe('configFor', () => {
    /**
     * 🔴 **The counter is derived, so "limit without counter" cannot exist.**
     *
     * M14.4b makes `character_counter` **required** whenever `max_length` is
     * set — *"silently rejecting the 21st character of an engraving is a support
     * ticket and often an abandoned cart"*. A merchant-facing checkbox could
     * express the forbidden state; deriving it here means the pair is always
     * consistent by construction.
     */
    it('always pairs a limit with a counter', () => {
      expect(configFor('text_field', 20)).toEqual({
        validation: { maxLength: 20 },
        display: { characterCounter: true },
      });
    });

    /** No limit publishes nothing — not empty objects. */
    it.each([null, undefined])('publishes nothing for %s', (value) => {
      expect(configFor('text_field', value)).toEqual({});
    });

    /**
     * A limit on a type that cannot have one is dropped rather than sent.
     *
     * The field is hidden for those types, so a value here means stale state —
     * a merchant who typed a limit, then switched the type. Sending it would
     * store a rule the storefront ignores.
     */
    it.each(['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'])(
      'drops a limit on %s',
      (presentation) => {
        expect(configFor(presentation, 20)).toEqual({});
      },
    );
  });

  describe('keyFromLabel', () => {
    /**
     * 🔴 **The key is the field merchants have no intuition for.**
     *
     * The editor asked them to invent a machine identifier beside a name they
     * had just typed — a question with one sensible answer. Deriving it removes
     * the question; the field stays editable because a key is permanent once
     * published, and renaming a label must not silently change what the
     * storefront resolves against.
     */
    it.each([
      ['Colour', 'colour'],
      ['Delivery notes', 'delivery_notes'],
      ['Extra sets', 'extra_sets'],
      ['  Padded  ', 'padded'],
      ['Size (cm)', 'size_cm'],
      ['Gift-wrap?', 'gift_wrap'],
      ['UPPER case', 'upper_case'],
    ])('derives %j into %j', (label, expected) => {
      expect(keyFromLabel(label)).toBe(expected);
    });

    /**
     * ⚠️ **A label with nothing usable produces `''`, not an invented key.**
     *
     * An empty key fails the schema, which is the correct outcome: the merchant
     * is told to type something rather than handed an identifier nobody chose.
     */
    it.each(['', '   ', '!!!', '???'])('produces nothing for %j', (label) => {
      expect(keyFromLabel(label)).toBe('');
    });

    /** The result always satisfies the schema's own key rule. */
    it('produces a key the schema accepts', () => {
      const parsed = optionSchema.safeParse({
        key: keyFromLabel('Delivery notes'),
        label: 'Delivery notes',
        presentation: 'text_field',
        isRequired: false,
      });

      expect(parsed.success).toBe(true);
    });
  });

  describe('length window', () => {
    /**
     * 🔴 **A minimum above the maximum refuses every possible answer.**
     *
     * Caught in the schema so a merchant is told while looking at both fields,
     * rather than after a round trip. The API refuses it too — this is the
     * courtesy, that is the truth.
     */
    it('rejects a minimum that cannot fit inside the maximum', () => {
      const parsed = optionSchema.safeParse({
        key: 'engraving',
        label: 'Engraving',
        presentation: 'text_field',
        isRequired: false,
        minLength: 20,
        maxLength: 10,
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.path[0] === 'minLength')).toBe(true);
    });

    it('accepts a window where the minimum fits', () => {
      const parsed = optionSchema.safeParse({
        key: 'engraving',
        label: 'Engraving',
        presentation: 'text_field',
        isRequired: false,
        minLength: 5,
        maxLength: 10,
      });

      expect(parsed.success).toBe(true);
    });

    /** Equal bounds are a window of exactly one length, not an error. */
    it('accepts a minimum equal to the maximum', () => {
      const parsed = optionSchema.safeParse({
        key: 'engraving',
        label: 'Engraving',
        presentation: 'text_field',
        isRequired: false,
        minLength: 8,
        maxLength: 8,
      });

      expect(parsed.success).toBe(true);
    });

    it('publishes both bounds when both are set', () => {
      expect(configFor('text_field', 20, 5)).toEqual({
        validation: { maxLength: 20, minLength: 5 },
        display: { characterCounter: true },
      });
    });

    /**
     * ⚠️ **A minimum alone gets no counter.**
     *
     * M14.4b ties the counter to `max_length` — a customer counting *up* with no
     * ceiling has nothing to count toward, and `3/` with nothing after the slash
     * is worse than no counter at all.
     */
    it('publishes a minimum without a counter', () => {
      expect(configFor('text_field', null, 5)).toEqual({
        validation: { minLength: 5 },
      });
    });

    it('publishes nothing when neither bound is set', () => {
      expect(configFor('text_field', null, null)).toEqual({});
    });

    it('drops both bounds on a type that cannot have them', () => {
      expect(configFor('radio', 20, 5)).toEqual({});
    });
  });

  describe('acceptsLength', () => {
    it.each(['text_field', 'textarea'])('accepts a limit for %s', (presentation) => {
      expect(acceptsLength(presentation)).toBe(true);
    });

    /*
     * ⚠️ `number_field` is here deliberately. It takes no *length* limit — its
     * `min`/`max` bound the value, which is a different rule with a different
     * meaning, so the length field must not appear for it.
     */
    it.each([
      'radio',
      'dropdown',
      'checkbox',
      'color_swatch',
      'image_swatch',
      'number_field',
      'range',
      'quantity',
      'date_picker',
      'time_picker',
      'datetime_picker',
      'hidden',
      'not-a-type',
    ])(
      'refuses a limit for %s',
      (presentation) => {
        expect(acceptsLength(presentation)).toBe(false);
      },
    );
  });

  describe('takesValues', () => {
    /**
     * 🔴 **The rule that decides whether "add value" is offered at all.**
     *
     * Mirrors `takesValues` in the API registry. If these drift, the dashboard
     * invites a merchant to create values the API refuses with
     * `TYPE_TAKES_NO_VALUES` — a form that exists only to produce an error.
     *
     * Tested here, not through the editor: `AddValue` uses `useMutation` and
     * cannot be rendered by `renderToStaticMarkup`, which is precisely how the
     * two swatch mutants above survived.
     */
    it.each([
      'text_field',
      'textarea',
      'number_field',
      'range',
      'quantity',
      'date_picker',
      'time_picker',
      'datetime_picker',
      'hidden',
    ])(
      'says %s takes none',
      (presentation) => {
        expect(takesValues(presentation)).toBe(false);
      },
    );

    it.each(['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'])(
      'says %s takes values',
      (presentation) => {
        expect(takesValues(presentation)).toBe(true);
      },
    );

    /**
     * An unrecognised type is assumed to take values.
     *
     * The opposite of `swatchFieldsFor`'s default, and deliberately so. A type
     * this build does not know is far more likely to be a choice type from a
     * newer API than a valueless one; showing a form the merchant does not need
     * is a smaller harm than hiding one they do.
     */
    it.each(['not-a-type', ''])('assumes %s takes values', (presentation) => {
      expect(takesValues(presentation)).toBe(true);
    });

    /**
     * ⚠️ **Every authorable type is decided, none by accident.**
     *
     * A new entry in `AUTHORABLE_TYPES` gets an answer from this function
     * whether or not anyone thought about it. This asserts the answers are the
     * intended ones rather than whatever the default produced.
     */
    it('answers for every authorable type', () => {
      const valueless = AUTHORABLE_TYPES.filter((type) => !takesValues(type.value)).map(
        (type) => type.value,
      );

      expect(valueless).toEqual([
        'text_field',
        'textarea',
        'number_field',
        'range',
        'quantity',
        'date_picker',
        'time_picker',
        'datetime_picker',
        'hidden',
        // M15.2: the customer supplies the file, so there is no value list.
        'file_input',
      ]);
    });

    /** Never both: a value carries one kind of swatch or none. */
    it.each(AUTHORABLE_TYPES.map((type) => type.value))('never asks %s for both', (presentation) => {
      const fields = swatchFieldsFor(presentation);

      expect(fields.color && fields.image).toBe(false);
    });
  });

  describe('value', () => {
    const base = { valueKey: 'lux', label: 'Luxury' };

    it.each(['10.50', '0', '-5', '', '   '])('accepts the amount %s', (amount) => {
      expect(valueSchema.safeParse({ ...base, amount }).success).toBe(true);
    });

    /** The money module refuses these; the schema must agree rather than duplicate. */
    it.each(['ten', '1e3', '1,000', '£10', '10000000.01'])('refuses the amount %s', (amount) => {
      expect(valueSchema.safeParse({ ...base, amount }).success).toBe(false);
    });

    it('says what a valid amount looks like', () => {
      const result = valueSchema.safeParse({ ...base, amount: 'ten' });

      expect(result.error?.issues[0].message).toContain('10.50');
    });
    /**
     * 🔴 **A colour reaches a `style` attribute, so its shape is a boundary.**
     *
     * The API's DTO rejects a malformed hex and the storefront template refuses
     * to paint one — `esc_attr` alone would happily emit
     * `red; background-image:url(...)` as an attribute value. This rejects it
     * before it is sent, which is a courtesy to the merchant rather than the
     * boundary itself. Three checks, deliberately: the two that matter are the
     * ones a merchant cannot reach.
     */
    it.each(['#1a2b3c', '#FFFFFF', ''])('accepts the colour %s', (colorHex) => {
      expect(valueSchema.safeParse({ ...base, amount: '', colorHex }).success).toBe(true);
    });

    it.each(['red', '#fff', '#1a2b3g', 'red; background-image:url(x)'])(
      'rejects the colour %s',
      (colorHex) => {
        expect(valueSchema.safeParse({ ...base, amount: '', colorHex }).success).toBe(false);
      },
    );

    /*
     * ✏️ A padded value is **accepted**, not rejected — the schema trims before
     * testing and the client trims before sending, so `'#1a2b3c '` reaches the
     * API as `'#1a2b3c'`. An earlier version of this listed it as invalid and
     * failed against correct code: stray whitespace is a typing artefact, and
     * refusing a merchant's colour over a trailing space would be hostile.
     */
    it('accepts a colour with stray whitespace', () => {
      expect(valueSchema.safeParse({ ...base, amount: '', colorHex: '  #1a2b3c ' }).success).toBe(
        true,
      );
    });

    /** Absolute only — a relative URL resolves against the merchant's own domain. */
    it.each(['https://example.test/a.png', 'http://example.test/a.png', ''])(
      'accepts the image URL %s',
      (imageUrl) => {
        expect(valueSchema.safeParse({ ...base, amount: '', imageUrl }).success).toBe(true);
      },
    );

    it.each(['/a.png', 'example.test/a.png', 'javascript:alert(1)'])(
      'rejects the image URL %s',
      (imageUrl) => {
        expect(valueSchema.safeParse({ ...base, amount: '', imageUrl }).success).toBe(false);
      },
    );

  });

  describe('group', () => {
    it('accepts a label with no description', () => {
      expect(groupSchema.safeParse({ label: 'Finish' }).success).toBe(true);
    });

    it('refuses an over-long description', () => {
      expect(groupSchema.safeParse({ label: 'F', description: 'x'.repeat(2001) }).success).toBe(false);
    });
  });
});

describe('takesGroupLabel', () => {
  /**
   * ⚠️ **`dropdown` only.** Grouping is a rendering detail of a `<select>`; the
   * radio and swatch templates ignore `group_label` entirely, so offering the
   * field there would let a merchant fill in something that silently does
   * nothing.
   */
  it('is offered for a dropdown', () => {
    expect(takesGroupLabel('dropdown')).toBe(true);
  });

  it.each(['radio', 'checkbox', 'color_swatch', 'image_swatch', 'text_field', 'hidden'])(
    'is not offered for %s',
    (presentation) => {
      expect(takesGroupLabel(presentation)).toBe(false);
    },
  );
});

describe('valueSchema groupLabel', () => {
  const base = { valueKey: 'sm', label: 'Small', amount: '' };

  /** Blank means "not grouped" — what every dropdown had before grouping. */
  it('accepts a blank heading', () => {
    expect(valueSchema.safeParse({ ...base, groupLabel: '' }).success).toBe(true);
  });

  it('accepts an absent heading', () => {
    expect(valueSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a normal heading', () => {
    expect(valueSchema.safeParse({ ...base, groupLabel: 'Standard sizes' }).success).toBe(true);
  });

  /** Matches the API's 200-character cap, so the form refuses before the server does. */
  it('refuses a heading beyond the cap', () => {
    expect(valueSchema.safeParse({ ...base, groupLabel: 'x'.repeat(201) }).success).toBe(false);
  });

  it('accepts a heading at exactly the cap', () => {
    expect(valueSchema.safeParse({ ...base, groupLabel: 'x'.repeat(200) }).success).toBe(true);
  });
});

describe('whitespace-only text is refused everywhere', () => {
  /**
   * 🔴 **`.min(1)` counts whitespace.**
   *
   * `"   "` has length 3, so the editor's Save button enabled, the spaces were
   * sent, and the API stored `''` — its own `@MinLength(1)` measured the
   * untrimmed value the same way. Measured on four endpoints before both sides
   * were fixed.
   */
  it.each([
    ['a set name', () => createSetSchema.safeParse({ name: '   ', storeId: crypto.randomUUID() })],
    ['a group label', () => groupSchema.safeParse({ label: '   ' })],
    ['an option label', () => optionSchema.safeParse({ key: 'k', label: '   ', presentation: 'radio' })],
    ['a value label', () => valueSchema.safeParse({ valueKey: 'k', label: '   ', amount: '' })],
  ])('refuses %s of only spaces', (_name, parse) => {
    expect(parse().success).toBe(false);
  });

  /** Tabs and newlines are whitespace too — `.trim()` handles both. */
  it('refuses tabs and newlines', () => {
    expect(groupSchema.safeParse({ label: '\t\n ' }).success).toBe(false);
  });

  it('trims a valid label rather than refusing it', () => {
    const parsed = groupSchema.safeParse({ label: '  Sizing  ' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.label).toBe('Sizing');
  });

  /**
   * The maximum is measured **after** trimming, matching the API, so trailing
   * spaces cannot push a legitimate label over the limit.
   */
  it('measures the maximum after trimming', () => {
    const atLimit = 'x'.repeat(OPTION_SET_LIMITS.MAX_GROUP_LABEL);

    expect(groupSchema.safeParse({ label: `  ${atLimit}  ` }).success).toBe(true);
    expect(groupSchema.safeParse({ label: `${atLimit}x` }).success).toBe(false);
  });

  it('still accepts interior whitespace', () => {
    const parsed = groupSchema.safeParse({ label: 'Extra  Large' });

    expect(parsed.success && parsed.data.label).toBe('Extra  Large');
  });
});

describe('the group layouts a merchant can choose', () => {
  /**
   * 🔴 **`stepped` must NOT be offered while it renders as `inline`** (ADR-063).
   *
   * The API accepts four values; this list offers three. A fourth choice that
   * silently behaves like the first is how a merchant discovers a gap in
   * production, after they have published — which is exactly what ADR-055 and
   * ADR-056 withdrew two rule actions to avoid.
   */
  it('does not offer stepped', () => {
    expect(GROUP_LAYOUTS.map((layout) => layout.value)).not.toContain('stepped');
  });

  /**
   * ⚠️ The control: the three that ARE drawn are all offered.
   *
   * Without this, "stepped is absent" would be satisfied by an empty list.
   */
  it('offers every layout the storefront draws', () => {
    expect(GROUP_LAYOUTS.map((layout) => layout.value)).toEqual([
      'inline',
      'accordion',
      'tabs',
    ]);
  });

  /**
   * Each entry carries what the picker needs to be chosen from quickly — the
   * same reason `AUTHORABLE_TYPES` carries an icon and a hint.
   */
  it('gives every layout a label, a hint and an icon', () => {
    GROUP_LAYOUTS.forEach((layout) => {
      expect(layout.label).not.toBe('');
      expect(layout.hint).not.toBe('');
      expect(layout.icon).not.toBe('');
    });
  });

  it('accepts a layout it offers and refuses one it does not', () => {
    expect(groupDisplaySchema.safeParse({ displayType: 'accordion', isCollapsible: false }).success).toBe(
      true,
    );
    expect(groupDisplaySchema.safeParse({ displayType: 'stepped', isCollapsible: false }).success).toBe(
      false,
    );
  });
});

describe('which types may take several answers', () => {
  /**
   * 🔴 **`checkbox` alone**, matching the API registry (M18.3) and the plugin's
   * `MANY_CAPABLE_TYPES`. Three lists, one decision.
   */
  it('offers several answers for a checkbox', () => {
    expect(acceptsManyAnswers('checkbox')).toBe(true);
  });

  /**
   * ⚠️ **Anything else would be an unsellable option.** The API refuses `many`
   * for a type its registry does not allow, so the merchant would author,
   * submit, and be handed an `INCOMPATIBLE_AXIS` error — and a `radio` at
   * `many` reaching the storefront would sell two sizes of one shirt.
   */
  it('refuses every other type, including the ones that look similar', () => {
    ['radio', 'dropdown', 'color_swatch', 'image_swatch', 'text_field', 'file_input'].forEach(
      (presentation) => {
        expect(acceptsManyAnswers(presentation)).toBe(false);
      },
    );
  });

  /** An unknown type takes the single-value path, as everywhere else. */
  it('refuses a type it does not recognise', () => {
    expect(acceptsManyAnswers('a_type_from_a_newer_cloud')).toBe(false);
  });
});

describe('laying choices out in columns (M18.6a)', () => {
  /**
   * 🔴 **`columns` was published, read by thirteen storefront files, and
   * authorable nowhere** (ADR-064) — the fourth occurrence in Phase 18 of a
   * capability built on both sides with no way for a merchant to reach it.
   */
  it('offers columns for the five choice types', () => {
    ['radio', 'checkbox', 'color_swatch', 'image_swatch', 'dropdown'].forEach((presentation) => {
      expect(acceptsColumns(presentation)).toBe(true);
    });
  });

  /** ⚠️ A column count on a text field would be a grid with one cell. */
  it('refuses columns for types the registry does not accept them for', () => {
    ['text_field', 'textarea', 'number_field', 'date_picker', 'file_input'].forEach(
      (presentation) => {
        expect(acceptsColumns(presentation)).toBe(false);
      },
    );
  });

  /** Bounds copied from `choiceDisplaySchema`, which the API enforces. */
  it('offers exactly the counts the API accepts', () => {
    expect([...COLUMN_CHOICES]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * ⚠️ **One column publishes nothing.** It is what an option renders as when
   * it says nothing, so sending it would store a value that changes nothing and
   * make every default option carry a `display` object.
   */
  it('sends no display for a single column', () => {
    expect(layoutFor('radio', 1)).toEqual({});
    expect(layoutFor('radio', null)).toEqual({});
  });

  it('sends the column count when the merchant asks for a grid', () => {
    expect(layoutFor('radio', 3)).toEqual({ display: { columns: 3 } });
  });

  /** A type that cannot take columns publishes none, whatever is passed. */
  it('sends nothing for a type that cannot be gridded', () => {
    expect(layoutFor('text_field', 4)).toEqual({});
  });
});

describe('merging option config', () => {
  /**
   * 🔴 **The defect this exists to prevent, asserted directly.**
   *
   * `{ ...configFor(), ...layoutFor() }` replaces the whole `display` object
   * rather than merging it, so `characterCounter` would vanish — and M14.4b
   * makes that counter **required** whenever `maxLength` is set.
   *
   * ⚠️ **The two cannot collide today**, because `columns` is choice-only and
   * `characterCounter` text-only. Asserted anyway: a helper that relies on
   * which fields happen not to overlap breaks the first time one does.
   */
  it('keeps both display keys when two parts each carry one', () => {
    expect(
      mergeConfig({ display: { characterCounter: true } }, { display: { columns: 3 } }),
    ).toEqual({ display: { characterCounter: true, columns: 3 } });
  });

  it('merges validation the same way', () => {
    expect(mergeConfig({ validation: { maxLength: 20 } }, { validation: { minLength: 2 } })).toEqual(
      { validation: { maxLength: 20, minLength: 2 } },
    );
  });

  /** Nothing to say publishes no empty objects. */
  it('omits a half that has nothing in it', () => {
    expect(mergeConfig({ validation: { maxLength: 20 } })).toEqual({
      validation: { maxLength: 20 },
    });
    expect(mergeConfig({}, {})).toEqual({});
  });
});
