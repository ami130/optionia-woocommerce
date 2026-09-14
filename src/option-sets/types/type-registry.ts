import { z } from 'zod';

import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';
import {
  perCharPricing,
  perUnitPricing,
  pricingConfigSchema,
  tieredPricing,
} from './pricing.schema';

/**
 * What every option type declares about itself.
 *
 * **The registry is the extension point Phase 14 uses.** Adding `dropdown` or
 * `color_swatch` should be one entry here — a presentation, three schemas, and
 * whether it takes values — not an edit spread across a validator, a serializer
 * and a controller. M7.3 asks for exactly that: build the registry so Phase 14
 * is registration, not refactoring.
 *
 * The three-axis model (M5.4b) is why an entry keys on `presentation` rather than
 * on a flat type name. `radio` and `dropdown` are the same `choice`/`one` pair
 * rendered differently, and `checkbox` is that pair at a different cardinality —
 * so the axes carry the behaviour and the presentation carries the rendering.
 */
export interface OptionTypeDefinition {
  /** How this type renders. The registry key. */
  readonly presentation: Presentation;

  /** What kind of value it produces, and how many. */
  readonly valueKind: ValueKind;
  readonly cardinality: readonly Cardinality[];

  /**
   * Whether the merchant defines a list of values for it.
   *
   * `radio` does; a text field does not. This is what decides whether an option
   * with no values is a mistake or the normal case, which the pre-publish checks
   * in M7.4 need to know.
   */
  readonly takesValues: boolean;

  /** Shape of `options.validation`. */
  readonly validationSchema: z.ZodType;

  /** Shape of `options.display`. */
  readonly displaySchema: z.ZodType;

  /**
   * Shape of `options.pricing` — type-level pricing.
   *
   * Per-value amounts live on `option_values.price_config` and are validated by
   * `pricingConfigSchema` directly, because a value's price does not depend on
   * how the option renders.
   */
  readonly pricingSchema: z.ZodType;
}

/**
 * Validation shared by every choice-based type.
 *
 * `radio`, `dropdown`, `checkbox` and both swatch types differ in rendering and
 * agree on everything else, so their validation is written once. Phase 14
 * registers four presentations against these same schemas rather than copying
 * them.
 */
const choiceValidationSchema = z
  .object({
    /**
     * Whether the merchant must pick something.
     *
     * Duplicated from `options.is_required` deliberately? No — it is **not** here.
     * `is_required` is a column because every type has it; this object holds only
     * what varies by type.
     */
    minSelections: z.number().int().min(0).max(100).optional(),
    maxSelections: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.minSelections !== undefined &&
      value.maxSelections !== undefined &&
      value.minSelections > value.maxSelections
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minSelections'],
        message: `Minimum selections (${value.minSelections}) exceeds the maximum (${value.maxSelections}).`,
      });
    }
  });

/** Display options shared by choice types. */
const choiceDisplaySchema = z
  .object({
    /** Columns in the rendered grid. One means a vertical list. */
    columns: z.number().int().min(1).max(6).optional(),
    /*
     * ✏️ **`labelPlacement` and `showPriceDelta` were withdrawn in M18.6a**
     * (ADR-064), not deferred.
     *
     * `showPriceDelta` was a second spelling of `priceDisplay` below: anything
     * the boolean could say, the enum says more precisely, and the two could
     * contradict each other — `{ priceDisplay: 'hidden', showPriceDelta: true }`
     * is a state no rendering can satisfy.
     *
     * `labelPlacement` reached nothing at either end, and `above | inline |
     * hidden` is a theme's job: every label already renders inside a `<legend>`
     * or `<label>` a stylesheet can place, and `hidden` would strip the
     * accessible name from a priced control.
     */

    /**
     * How a price is written beside a choice.
     *
     * `delta` is `+£10`, `total` is `£60`, `hidden` shows none. A merchant
     * selling a £50 shirt with a £10 embroidery may prefer either framing, and
     * the wrong one reads as a second charge.
     */
    priceDisplay: z.enum(['delta', 'total', 'hidden']).optional(),

    /**
     * How large a swatch is drawn.
     *
     * ⚠️ **This is what `swatch_grid` actually was.** M14.3 lists it as a
     * separate *type*, but a grid of swatches is `image_swatch` with `columns`
     * and a size — a display decision, not a different question asked of the
     * customer. Registering a type for it would duplicate two settings that
     * already exist.
     */
    swatchSize: z.enum(['small', 'medium', 'large']).optional(),

    /** A long optional section, folded away until the customer opens it. */
    collapsedByDefault: z.boolean().optional(),

    /**
     * On-demand explanation for a term the customer may not know.
     *
     * Distinct from `help_text`, which is always visible: a tooltip is for the
     * word a few customers will not recognise, where permanent text would be
     * clutter for everyone else.
     *
     * ⚠️ **Must be keyboard-reachable** (M29.7b) — a tooltip only reachable by
     * hover is invisible to a large group of customers, so the template renders
     * it as focusable rather than as a `title` attribute.
     */
    tooltip: z.string().max(300).optional(),
  })
  .strict();

/**
 * Type-level pricing for a choice type.
 *
 * Always null: a radio's price comes from whichever value is selected, and a
 * type-level amount would be charged in addition to it — silently doubling every
 * priced option. Refusing it outright is clearer than accepting a field nothing
 * reads.
 */
const noTypeLevelPricing = z
  .null()
  .describe('Choice options price per value, not per option.');

/**
 * Type-level pricing for an option that produces a **number**.
 *
 * `per_unit` is the second type `PRICING-SPEC.md` defines at the option level,
 * and for the same structural reason as `per_char`: the number types have no
 * values, so there is no value row to carry a `price_config`.
 *
 * ## Why it is restricted by type
 *
 * The evaluator dispatches on `pricing.type` and cannot see what kind of answer
 * an option produces, so without this it multiplies by whatever arrives — a
 * date's `"2026-10-01"` is not a quantity, and neither is an engraving. The
 * registry is the only place that knows the presentation, so a clear error at
 * authoring time belongs here.
 *
 * ⚠️ **A number option's answer has no length ceiling** the way text does, so a
 * merchant pricing per unit should also bound it: the evaluator refuses a
 * product beyond the safe integer range, which reads to a customer as an option
 * that silently stopped charging. `min`, `max` and `integer_only` are the
 * merchant's tools for that and are validated already.
 *
 * ## `tiered` joins it (M16.3), and for the same structural reason
 *
 * A `tiered` price brackets a quantity, so it belongs wherever a quantity comes
 * from. It was in the **value-level** union until M16.3 — configurable only on a
 * radio choice, which has no quantity to bracket — so a merchant could save a
 * tiered price and have it charge nothing. `tiered` is `per_unit` with the
 * amount chosen by a lookup rather than fixed.
 *
 * Nullable because most number options are free.
 */
const numberOptionPricing = z
  .discriminatedUnion('type', [perUnitPricing, tieredPricing])
  .nullable()
  .describe('A number option may price per unit, by bracket, or not at all.');

/**
 * Type-level pricing for an option the **customer types into**.
 *
 * `per_char` is the one price type `PRICING-SPEC.md` defines at the option
 * level, because a text field has no values and therefore no value row to carry
 * a `price_config`.
 *
 * ## Why this is restricted by type rather than accepted everywhere
 *
 * The evaluator dispatches on `pricing.type` and has no view of what kind of
 * answer the option produces. Measured, with the gate open and no restriction:
 *
 * ```text
 * per_char on a FILE option   -> 64-character upload token -> charged 32.00
 * per_char on a DATE option   -> "2026-10-01"              -> charged  5.00
 * per_char on a NUMBER option -> "12345"                   -> charged  2.50
 * ```
 *
 * A customer paying 32.00 for the length of a hash they never typed is not a
 * configuration a merchant could have meant. Refusing it here — where the type
 * is known — is better than teaching the evaluator about presentation, which
 * `Engine/` deliberately does not read.
 *
 * `hidden` is text-valued and still excluded: its value is the merchant's own
 * `default_value`, never customer input, so charging per character would bill a
 * customer for the length of a campaign tag.
 *
 * Nullable because most text options are free.
 */
const textOptionPricing = z
  .discriminatedUnion('type', [perCharPricing])
  .nullable()
  .describe('A text option may price per character typed, or not at all.');

/**
 * Validation for a free-text option.
 *
 * `minLength` and `maxLength` count **graphemes**, via the one normative
 * measurement (M11.1a) — `Intl.Segmenter` here and `Engine\Text::measure()` in
 * the plugin, verified equal on twelve cases including combining marks, ZWJ
 * families and flags.
 *
 * That shared function is the whole point: in `optionia-app` the price and the
 * character counter were written separately, so `"AB CD"` charges five and
 * displays four — live there today. It is not a pricing bug, it is a
 * credibility one, and it lands on engraving.
 */
const textValidationSchema = z
  .object({
    minLength: z.number().int().min(0).max(5000).optional(),
    maxLength: z.number().int().min(1).max(5000).optional(),

    /**
     * A merchant-authored regular expression.
     *
     * 🔴 **The one rule a merchant writes as code**, which M14.4 calls a
     * security boundary: it runs on every add-to-cart, so a catastrophically
     * backtracking pattern is a denial-of-service vector.
     *
     * Length-capped here; the *shape* check (`(a+)+` and friends) lives in
     * `patternsAreSafe` at publish, because refusing it at authoring would stop
     * a merchant saving a draft they are still writing.
     */
    pattern: z.string().max(200, 'A validation pattern that long is almost certainly a mistake.').optional(),

    /**
     * A named character set, not a merchant-supplied character list.
     *
     * A set has one meaning both languages agree on; a hand-written list would
     * be a second pattern with none of a pattern's safeguards.
     */
    allowedCharset: z.enum(['alpha', 'alphanumeric', 'numeric', 'latin']).optional(),

    /**
     * Words the merchant will not have engraved.
     *
     * Capped at 200: a list longer than that is a content-moderation product,
     * not an option rule, and every entry costs a substring scan on every
     * add-to-cart.
     */
    forbiddenWords: z.array(z.string().min(1).max(100)).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.minLength !== undefined &&
      value.maxLength !== undefined &&
      value.minLength > value.maxLength
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minLength'],
        message: `Minimum length (${value.minLength}) exceeds the maximum (${value.maxLength}).`,
      });
    }
  });

/**
 * Validation for a numeric option.
 *
 * ⚠️ **`min`/`max` are bounds on the *value*, not on its length** — which is why
 * a number cannot reuse `textValidationSchema`. "At least 5" and "at least 5
 * characters" are different questions, and a schema that conflated them would
 * accept `min: 5` meaning either.
 *
 * `step` is validated positive because a zero or negative step describes no
 * grid, and the plugin treats one as no rule at all rather than refusing every
 * answer.
 */
const numberValidationSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive('A step of zero or less describes no grid.').optional(),
    integerOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: `Minimum (${value.min}) exceeds the maximum (${value.max}).`,
      });
    }

    /*
     * A step wider than the range admits at most one value, and often none —
     * `min: 5, max: 10, step: 100` accepts only 5. Refused at authoring because
     * a merchant almost certainly meant something else.
     */
    if (
      value.min !== undefined &&
      value.max !== undefined &&
      value.step !== undefined &&
      value.step > value.max - value.min
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['step'],
        message: `A step of ${value.step} is wider than the range it steps through.`,
      });
    }
  });

/**
 * Validation for a slider.
 *
 * 🔴 **`min` and `max` are required here, unlike every other numeric type.**
 *
 * A number field without bounds is an open question a customer answers freely. A
 * *slider* without bounds has nothing to slide between — the browser defaults to
 * 0–100 silently, so a merchant who forgot would ship a control whose range they
 * never chose and cannot see is wrong.
 *
 * `step` stays optional and defaults to 1 at render, which is HTML's own
 * default and the answer a merchant means when they do not say.
 */
/**
 * What a merchant may require of an uploaded file (M15.3).
 *
 * ⚠️ **These are the *option's* rules, and they are the middle of three
 * ceilings** (ADR-041). The host's own `upload_max_filesize` caps them from
 * below — a merchant configuring 20 MB on a 2 MB host has configured something
 * their server refuses — and the tenant's `Plan.limits.file_storage_mb` caps
 * total storage from above, which M15.6 meters. Confusing any two silently
 * enforces the wrong one.
 *
 * `acceptedTypes` is a merchant-facing allowlist and **not** the security
 * boundary. WordPress refuses SVG and executables by content before this is
 * consulted, and `Upload\UploadStore` strips executable extensions regardless.
 * This decides what a *particular option* wants, so a "logo" field can insist on
 * PNG while an "artwork" field takes PDF.
 */
const fileValidationSchema = z
  .object({
    /**
     * Extensions this option accepts, lowercase and without a dot.
     *
     * Empty or absent means "whatever the platform allows", which is already a
     * strict allowlist — not "anything".
     */
    acceptedTypes: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9]{1,10}$/, 'Use a plain extension like pdf or png, without a dot.'),
      )
      .max(20, 'More than twenty accepted types is a field nobody can explain.')
      .optional(),

    /** Per-file ceiling. The host may enforce something lower. */
    maxSizeMb: z
      .number()
      .int()
      .positive('A maximum of zero would refuse every file.')
      .max(500, 'Files above 500 MB belong in a transfer service, not a checkout.')
      .optional(),

    /**
     * ⚠️ **Capped at 1 until the array path exists.**
     *
     * `Engine\SelectionResolver` refuses any non-scalar selection, deliberately,
     * to repel array-injection probes — and no registered type has ever used
     * `Cardinality.MANY`. Accepting `maxFiles: 5` here would let a merchant
     * publish an option the storefront cannot post. ADR-040 decided single-file
     * first for exactly this reason; raising this is the multi-file stage's job,
     * together with the resolver, cart, labels and order.
     */
    maxFiles: z
      .number()
      .int()
      .min(1)
      .max(1, 'Multi-file uploads arrive with the array path through cart and order.')
      .optional(),

    /**
     * Megapixel ceiling for images, checked from the header before any decode.
     *
     * 🔴 **Not a bomb defence alone — an ordinary camera exceeds it.** Measured:
     * a 48 MP photo is 183 MB decoded against a typical 128 MB `memory_limit`,
     * so a real customer with a DSLR kills the request. The plugin reads width
     * and height from the header (`getimagesize`) and refuses before decoding,
     * which is the only order that works.
     *
     * Configurable because the safe value follows the host's memory: ~24 MP at
     * 128 MB, four times that at 512 MB. A fixed constant would refuse
     * legitimate artwork on generous hosts and crash on modest ones.
     */
    maxMegapixels: z
      .number()
      .positive('A ceiling of zero would refuse every image.')
      .max(500, 'Beyond 500 MP no host decodes the image anyway.')
      .optional(),
  })
  .strict();

const rangeValidationSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    step: z.number().positive('A step of zero or less describes no grid.').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.min >= value.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: `A slider from ${value.min} to ${value.max} has nothing to slide between.`,
      });
    }

    if (value.step !== undefined && value.step > value.max - value.min) {
      ctx.addIssue({
        code: 'custom',
        path: ['step'],
        message: `A step of ${value.step} is wider than the range it steps through.`,
      });
    }
  });

/**
 * Validation for a date, time or datetime option.
 *
 * 🔴 **Four rules are absolute and two are relative**, and the split matters:
 * `minDate`, `maxDate`, `blackoutDates` and `allowedWeekdays` need no clock,
 * while `leadTimeDays` and `maxAdvanceDays` are measured from *today* in the
 * **store's** timezone. The plugin reads that from WordPress rather than the
 * document carrying a copy that can drift.
 *
 * Dates are ISO `YYYY-MM-DD` strings rather than a date type, because that is
 * what the document carries and what `<input type="date">` posts — and ISO
 * orders lexicographically, so a comparison needs no parsing.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are written as YYYY-MM-DD.');

const dateValidationSchema = z
  .object({
    minDate: isoDate.optional(),
    maxDate: isoDate.optional(),
    blackoutDates: z.array(isoDate).max(365, 'More than a year of closures is a calendar, not a rule.').optional(),

    /**
     * ISO-8601 weekdays: 1 is Monday, 7 is Sunday.
     *
     * Not PHP's `w` (0 = Sunday): a merchant configuring "weekdays" means
     * Monday to Friday, and a set starting on Sunday invites an off-by-one no
     * test would catch because both spellings look plausible.
     */
    allowedWeekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),

    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    maxAdvanceDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minDate !== undefined && value.maxDate !== undefined && value.minDate > value.maxDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['minDate'],
        message: `A window from ${value.minDate} to ${value.maxDate} contains no days.`,
      });
    }

    /*
     * A lead time longer than the booking horizon leaves no bookable day at
     * all — every date is either too soon or too far.
     */
    if (
      value.leadTimeDays !== undefined &&
      value.maxAdvanceDays !== undefined &&
      value.leadTimeDays > value.maxAdvanceDays
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['leadTimeDays'],
        message: `A lead time of ${value.leadTimeDays} days leaves nothing bookable within ${value.maxAdvanceDays}.`,
      });
    }

    // An empty weekday list would refuse every day of the week.
    if (value.allowedWeekdays !== undefined && value.allowedWeekdays.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedWeekdays'],
        message: 'Allowing no weekdays would refuse every date.',
      });
    }
  });

/** Display options for a text option. */
const textDisplaySchema = z
  .object({
    /* `labelPlacement` withdrawn in M18.6a — see the note on the choice schema. */

    /**
     * Show a live `12/20` beside the field.
     *
     * M14.4b makes this **required** whenever `maxLength` is set: silently
     * rejecting the 21st character of an engraving with no visible limit is the
     * defect it names. The counter itself is Stage 3c; the flag is stored now so
     * the document shape does not change under it.
     */
    characterCounter: z.boolean().optional(),

    /** As above — the same vocabulary, so a merchant learns it once. */
    priceDisplay: z.enum(['delta', 'total', 'hidden']).optional(),
    collapsedByDefault: z.boolean().optional(),
    tooltip: z.string().max(300).optional(),
  })
  .strict();

/**
 * The registry.
 *
 * Phase 7 shipped `radio` alone, per M7.3's scope discipline. Phase 14 adds
 * entries; nothing else in the system needs to change, which is the property
 * this shape exists to provide.
 *
 * ## `dropdown` is the measurement, not just a feature
 *
 * It is deliberately the **first** Phase 14 type, because it shares everything
 * with `radio` except how it draws: the same `choice`/`one` axes, the same
 * validation and display schemas, the same per-value pricing. If adding it costs
 * one entry here and one plugin template, the abstraction Phase 7 claimed is
 * real and the rest of Tier 1 is mechanical. If it costs more, that is learned
 * at the price of one type rather than seven.
 *
 * Measured while adding it: the backend needed **only this entry** — no
 * validator, serializer or controller change. `Engine\SelectionResolver` in the
 * plugin never reads `type` at all, so cart, pricing and order paths were
 * untouched too.
 */
const DEFINITIONS: readonly OptionTypeDefinition[] = [
  {
    presentation: Presentation.RADIO,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * A yes/no toggle at `one`, and a multi-select at `many`.
     *
     * ✅ **`MANY` was added in M18.3, once the whole path existed.** It was
     * withheld through M14.1 for a stated reason: the validator enforces
     * cardinality *from this list*, so declaring it early would have made the
     * API **accept** a multi-select that `Engine\SelectionResolver` then
     * refused — a merchant would author it, publish it, and a customer would
     * hit the error.
     *
     * ADR-057 set the bar as *the whole path*, not one stage of it. What had to
     * exist first, and now does: the resolver accepts and prices an array
     * (M18.1); `deltas` is keyed by option id so the cart can pair and freeze a
     * multi-value line (ADR-061); and the cart row, the order meta and the
     * checkout message all read a list of labels through one shared reader
     * (M18.2). Measured end to end: `Extras: Red, Blue (+3.00)` in the cart,
     * `Extras => 'Red, Blue'` in the order.
     *
     * 🔴 **`ONE` stays FIRST, and the order is load-bearing.**
     * `OptionsService.create()` defaults to `definition.cardinality[0]`, so an
     * option authored without an explicit cardinality is still a yes/no toggle.
     * Putting `MANY` first would silently turn every new checkbox into a
     * multi-select.
     *
     * ⚠️ **Existing options are untouched**, because `cardinality` is absent
     * from `OptionChanges` — immutable after creation, by type. Widening this
     * list cannot reach a checkbox that already exists, only offer a choice to
     * one being created.
     *
     * 📌 **The plugin keeps its own copy of this decision** in
     * `SelectionResolver::MANY_CAPABLE_TYPES`, because AC4 makes the published
     * document input rather than authority. The two lists must agree; this is
     * the authority, and that is the fence.
     */
    presentation: Presentation.CHECKBOX,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE, Cardinality.MANY],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * A colour chip per value, drawn from `option_values.colorHex`.
     *
     * The axes are radio's; what differs is that each value carries a colour the
     * template paints. That column has existed since Phase 5's schema, and the
     * serializer already publishes it as `color_hex` — so this entry needs no
     * schema work, only a template that reads it.
     *
     * `[ONE]` for the same reason as `checkbox` above.
     */
    presentation: Presentation.COLOR_SWATCH,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * An image per value, from `option_values.imageUrl`, published as `image_url`.
     *
     * Identical to `color_swatch` but for which value field the template reads —
     * which is what "one renderer, both cardinalities" in M14.1 means: the axes
     * carry behaviour, the presentation carries rendering, and a swatch differs
     * from a radio only in what it draws beside the label.
     */
    presentation: Presentation.IMAGE_SWATCH,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * The same option as `radio`, drawn as a `<select>`.
     *
     * Every field below is identical to radio's, and that is the point rather
     * than duplication: the three-axis model (M5.4b) puts the *behaviour* on
     * `valueKind` and `cardinality` and leaves `presentation` to carry only the
     * rendering. Two entries agreeing on six fields is what "one entry per type"
     * looks like when the axes are doing their job.
     */
    presentation: Presentation.DROPDOWN,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * 🔴 **The first type a *customer* supplies the value for.**
     *
     * Every type above it resolves against a merchant-authored `value_key`, and
     * that lookup is what made the plugin's *"nothing here is trusted"* comment
     * survivable — an unknown value was simply refused. Text removes that
     * guarantee, which is why the sanitising boundary
     * (`Engine\SelectionResolver::clean_text()`) was built and proven *before*
     * this entry made the type authorable.
     *
     * ⚠️ **`takesValues: false`, and it is load-bearing.** It is what tells the
     * publish check that an option with no values is the normal case rather than
     * a blocker (`optionsHaveValues`), and what stops the dashboard offering an
     * "add value" form for a field that cannot have any.
     *
     * `cardinality: [NONE]` for the same reason the choice types are `[ONE]`:
     * the axes must describe what the resolver actually does, and a text option
     * produces one string, not a selection from a set.
     */
    presentation: Presentation.TEXT_FIELD,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: textValidationSchema,
    displaySchema: textDisplaySchema,
    /**
     * `per_char`, and only `per_char`.
     *
     * A choice prices per value. Text has no values, so this is genuinely
     * *type-level* pricing and lives here.
     *
     * It was `noTypeLevelPricing` until M16.2, because accepting a config the
     * storefront could not charge would be a silent undercharge on every order.
     * The plugin charges it now — and the gate had to be lifted deliberately:
     * building the evaluator, the fixture and the contract left the feature
     * **unreachable**, because a merchant still could not save a price.
     */
    pricingSchema: textOptionPricing,
  },
  {
    /**
     * A text option whose line breaks are content.
     *
     * ⚠️ **The axes are `text_field`'s exactly** — `text` / `none` / no values —
     * and that is the point: the difference is not what the option *produces*,
     * it is how the storefront draws it and whether a newline survives.
     * `Engine\SelectionResolver::is_multiline()` keys on the presentation for
     * that one decision.
     *
     * Measured before the distinction existed: an address typed as three lines
     * was stored as one run-on line — wrong on a shipping label and wrong in a
     * workshop's notes.
     *
     * `maxLength` counts the same graphemes it does for a single line; a
     * line-count limit is M14.4's, not this entry's.
     */
    presentation: Presentation.TEXTAREA,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: textValidationSchema,
    displaySchema: textDisplaySchema,
    // Priced exactly as `text_field` is: the axes are identical, and a customer
    // engraving three lines is typing the same characters as one who typed one.
    pricingSchema: textOptionPricing,
  },
  {
    /**
     * A numeric option: a quantity, a size, a count.
     *
     * 🔴 **The first type whose `value_kind` is not `choice` or `text`.** That
     * matters because a number has an *ordering*: `min`/`max` bound the value
     * rather than its length, `step` describes a grid, and `"007"`, `"7"` and
     * `"7.0"` are one quantity written three ways — so
     * `Engine\SelectionResolver` stores a canonical form rather than the
     * customer's spelling, which is what lets two identical orders group into
     * one cart line.
     *
     * `takesValues: false` like the text types: the customer supplies the value.
     */
    presentation: Presentation.NUMBER_FIELD,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: numberValidationSchema,
    displaySchema: textDisplaySchema,
    /**
     * `per_unit`, and only `per_unit` — "£2 per centimetre", the pricing model a
     * number invites. Charged since M16.2.
     *
     * It was `noTypeLevelPricing` until then, and lifting that gate is half the
     * work: M16.2 shipped `per_char`'s evaluator while every type still refused
     * an option-level price, so the feature was unreachable while every test
     * passed. The registry entry is where a price type becomes configurable.
     */
    pricingSchema: numberOptionPricing,
  },
  {
    /**
     * A slider.
     *
     * The same `number` value the field produces, drawn as a track rather than a
     * box — so `Engine\SelectionResolver` needs **no new branch**: it keys on
     * `value_kind`, and a slider's answer is a number like any other.
     *
     * ⚠️ **Its validation is not `numberValidationSchema`.** `min` and `max` are
     * required, because a slider without bounds silently becomes a 0–100 control
     * the merchant never chose. That is the one thing a slider cannot inherit
     * from a number field.
     */
    presentation: Presentation.RANGE,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: rangeValidationSchema,
    displaySchema: textDisplaySchema,
    pricingSchema: numberOptionPricing,
  },
  {
    /**
     * A quantity: a number with steppers.
     *
     * Identical to `number_field` in every axis and rule — the difference is the
     * control a customer meets, which is what `presentation` is for.
     *
     * ⚠️ **The plan's *"interaction with product quantity"* is not here.** That
     * is `per_unit` pricing, and `SelectionResolver::resolve()` takes no
     * quantity argument — its docblock names one the signature does not have.
     * **M16.1** owns that; this entry owns the control and its bounds.
     */
    presentation: Presentation.QUANTITY,
    valueKind: ValueKind.NUMBER,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: numberValidationSchema,
    displaySchema: textDisplaySchema,
    pricingSchema: numberOptionPricing,
  },
  {
    /**
     * A calendar day — a wedding, a delivery date.
     *
     * All three share `value_kind: date` and one resolver branch; the
     * difference is **precision**, which `SelectionResolver::date_format()`
     * settles from the presentation. A wedding date has no time, a collection
     * slot has no day, and an appointment needs both.
     */
    presentation: Presentation.DATE_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: dateValidationSchema,
    displaySchema: textDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * A time of day — a collection slot.
     *
     * All three share `value_kind: date` and one resolver branch; the
     * difference is **precision**, which `SelectionResolver::date_format()`
     * settles from the presentation. A wedding date has no time, a collection
     * slot has no day, and an appointment needs both.
     */
    presentation: Presentation.TIME_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: dateValidationSchema,
    displaySchema: textDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * A day and a time — an appointment.
     *
     * All three share `value_kind: date` and one resolver branch; the
     * difference is **precision**, which `SelectionResolver::date_format()`
     * settles from the presentation. A wedding date has no time, a collection
     * slot has no day, and an appointment needs both.
     */
    presentation: Presentation.DATETIME_PICKER,
    valueKind: ValueKind.DATE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: dateValidationSchema,
    displaySchema: textDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
  {
    /**
     * A value the merchant sets and the customer never sees.
     *
     * 🔴 **Hidden from the page, not from the customer.** Anyone with developer
     * tools can post whatever they like for a hidden input — measured: a naive
     * implementation stored `FORGED-BY-CUSTOMER` over the merchant's own
     * `campaign-a`.
     *
     * So `Engine\SelectionResolver` **ignores what is posted entirely** and
     * stores the option's `default_value`. That is the only way a hidden field
     * can mean what a merchant intends: a batch code, a fulfilment route, a
     * campaign tag — data *about* the order rather than a choice within it.
     *
     * ⚠️ **Which is why `defaultValue` is where the value lives**, and why this
     * type has no validation of its own: there is no customer input to validate.
     */
    presentation: Presentation.HIDDEN,
    valueKind: ValueKind.TEXT,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: z.object({}).strict(),
    displaySchema: z.object({}).strict(),
    pricingSchema: noTypeLevelPricing,
  },

  /**
   * A file the customer uploads (M15.2, M15.3).
   *
   * ⚠️ **`Cardinality.NONE`, not `ONE`** — the same reasoning as `text_field`.
   * The customer supplies a value rather than selecting from a set the merchant
   * authored, so there is nothing to have "one of". `takesValues: false` follows.
   *
   * 🔴 **Registering this makes three Phase 7 tripwires fire, and that is the
   * point.** `type-registry.spec.ts` asserts `findType(FILE_INPUT)` is null,
   * `isRegistered` is false, and the unregistered list is exactly
   * `[FILE_INPUT]` — scope guards written when this was five phases away.
   * Updating them *is* the act of accepting Phase 15, which is why they were
   * written to fail loudly rather than to be quietly deleted.
   *
   * ⚠️ **The storefront value is an opaque token, never a path or a filename**
   * (ADR-040). The browser holds nothing else, and AC4's rule — identifiers
   * only — applies to a file exactly as it does to a colour swatch.
   */
  {
    presentation: Presentation.FILE_INPUT,
    valueKind: ValueKind.FILE,
    cardinality: [Cardinality.NONE],
    takesValues: false,
    validationSchema: fileValidationSchema,
    displaySchema: textDisplaySchema,
    /*
     * No type-level pricing, for the same reason as every customer-supplied
     * type: there is no value list to attach a price to. Charging per upload is
     * a pricing model (M16), not a property of the field.
     */
    pricingSchema: noTypeLevelPricing,
  },
];

const BY_PRESENTATION = new Map<string, OptionTypeDefinition>(
  DEFINITIONS.map((definition) => [definition.presentation, definition]),
);

/** Every registered type. */
export function registeredTypes(): readonly OptionTypeDefinition[] {
  return DEFINITIONS;
}

/**
 * Look up a type, or null if it is not registered.
 *
 * Null rather than a throw: an unregistered presentation is caller input, and
 * the caller turns it into a validation error naming what is supported. A throw
 * here would become a 500 for a typo in a request body.
 */
export function findType(presentation: string): OptionTypeDefinition | null {
  return BY_PRESENTATION.get(presentation) ?? null;
}

/** Whether a presentation has been implemented. */
export function isRegistered(presentation: string): boolean {
  return BY_PRESENTATION.has(presentation);
}

export { pricingConfigSchema };
