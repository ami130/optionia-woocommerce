import { z } from 'zod';

import { parseAmount } from '@/lib/money/money';

/**
 * The option-set API's validation rules, mirrored.
 *
 * Client-side validation is a **convenience** — the server checks everything
 * again — but a form that accepts what the API refuses wastes a round trip and
 * shows a message written for a developer. Every bound below is copied from
 * `optioniaWooCommerceBackend`'s DTOs, and `option-sets.test.ts` states each one
 * so a drift is a failing test rather than a surprised merchant.
 */

/** `@MaxLength` on each field, from the DTOs. */
const MAX_SET_NAME = 255;
const MAX_GROUP_LABEL = 160;
const MAX_GROUP_DESCRIPTION = 2000;
const MAX_OPTION_KEY = 64;
const MAX_OPTION_LABEL = 200;
const MAX_VALUE_KEY = 64;
const MAX_VALUE_LABEL = 200;

/**
 * `/^[a-z0-9][a-z0-9_-]*$/`, from `option.dto.ts` and `option-value.dto.ts`.
 *
 * 🔴 **A key is a field merchants have no intuition for.** Unlike a label, there
 * is nothing about "Large Size" that announces itself as invalid — so the form
 * has to say what a key may contain *before* the API throws a regex at them.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const KEY_MESSAGE =
  'Use lowercase letters, numbers, hyphens and underscores, starting with a letter or number.';

const key = (max: number) =>
  z
    .string()
    .min(1, 'A key is required.')
    .max(max, 'That key is too long.')
    .regex(KEY_PATTERN, KEY_MESSAGE);

/**
 * A required, human-readable string — trimmed, and refused when blank.
 *
 * 🔴 **`.min(1)` counts whitespace.** `"   "` has length 3, so a form using
 * `.min(1)` alone enabled its Save button, sent the spaces, and the API stored
 * `''` — its own `@MinLength(1)` measures the untrimmed value the same way.
 * Measured on four endpoints before the API grew `@Trimmed()`.
 *
 * ⚠️ **`.trim()` transforms, so the parsed value is what should be sent.** The
 * editors send their own raw state rather than `parsed.data`, which is why this
 * also *refuses* the blank case rather than only cleaning it — the guard has to
 * hold even when the caller ignores the output.
 *
 * The maximum is measured after trimming, matching the API, so trailing spaces
 * cannot push a legitimate label over the limit.
 */
const text = (max: number, required: string, tooLong: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length >= 1, { message: required })
    .refine((value) => value.length <= max, { message: tooLong });

export const createSetSchema = z.object({
  name: text(MAX_SET_NAME, 'Give this option set a name.', 'That name is too long.'),
  storeId: z.string().uuid('Choose a store.'),
});

export const renameSetSchema = z.object({
  name: text(MAX_SET_NAME, 'Give this option set a name.', 'That name is too long.'),
});

export const groupSchema = z.object({
  label: text(MAX_GROUP_LABEL, 'Give this group a label.', 'That label is too long.'),
  description: z
    .string()
    .max(MAX_GROUP_DESCRIPTION, 'That description is too long.')
    .optional(),
});

/**
 * The layouts a merchant can choose for a group.
 *
 * 🔴 **Three of the API's four, and `stepped` is the missing one** (ADR-063).
 * It renders as `inline` until its own stage, because a wizard needs a second
 * reason for a group to be hidden and the storefront's rule runtime recomputes
 * visibility from scratch on every change — so *"hidden by a rule"* and *"not
 * the current step"* would share one attribute.
 *
 * ⚠️ **Offering it anyway would be worse than omitting it.** A fourth choice
 * that silently behaves like the first is how a merchant discovers a gap in
 * production, after they have published. The same reasoning keeps
 * `AUTHORABLE_TYPES` a subset of the API's registry rather than a mirror of it.
 *
 * 📌 **`bin/check-option-type-parity.sh` holds the type list across the two
 * repositories; this list has no such gate**, because the storefront's
 * fallback makes a mismatch render rather than fail — an unknown layout draws
 * as `inline`. If that ever stops being true, this needs a gate.
 */
export const GROUP_LAYOUTS = [
  {
    value: 'inline',
    label: 'Inline',
    hint: 'Laid out on the page, one after another',
    icon: '▤',
  },
  {
    value: 'accordion',
    label: 'Accordion',
    hint: 'Folded behind its heading — the customer opens it',
    icon: '▸',
  },
  {
    value: 'tabs',
    label: 'Panel',
    hint: 'Set apart in its own bordered panel',
    icon: '▭',
  },
] as const;

export type GroupLayout = (typeof GROUP_LAYOUTS)[number]['value'];

/**
 * A group's presentation, as the editor sends it.
 *
 * ⚠️ **`isCollapsible` only means anything for `inline`** (ADR-059), and the
 * storefront enforces that rather than trusting the payload — an accordion is
 * already collapsible, and honouring the flag there would give two fields one
 * job. Sent as authored; the renderer resolves the overlap.
 */
export const groupDisplaySchema = z.object({
  displayType: z.enum(GROUP_LAYOUTS.map((layout) => layout.value) as [string, ...string[]]),
  isCollapsible: z.boolean(),
});

/**
 * The option types this editor can author **and re-open**.
 *
 * 🔴 **One list, because two drifted.** The picker in the editor and the schema
 * here were written separately, and nothing kept them in step: measured by
 * mutation, adding `checkbox` to the picker — a type the API rejects and this
 * schema forbids — passed all 305 tests and `tsc`. A merchant would have chosen
 * it and been handed an error.
 *
 * The `hint` lives here rather than in the component for the same reason: a
 * type's merchant-facing description is part of what makes it authorable, and
 * splitting the list from its labels is how the two came apart the first time.
 *
 * ⚠️ **The bar is the round trip, not registration in the API.** `text_field`
 * will be registered server-side long before it belongs here — it takes no
 * values, so the value editor is meaningless for it, and offering it would
 * create option sets this screen cannot open again.
 */
/**
 * The types a merchant can author, each with the icon the picker draws.
 *
 * 🔴 **An icon per entry, because a `<select>` of eight names is not a choice a
 * merchant can make quickly.** The names alone do not say that `radio` and
 * `dropdown` ask the same question, or that `text_field` and `textarea` differ
 * only in height — the shapes do, at a glance.
 */
export const AUTHORABLE_TYPES = [
  { value: 'radio', label: 'Radio buttons', hint: 'All choices visible at once' , icon: '◉' },
  { value: 'dropdown', label: 'Dropdown', hint: 'A list that opens — better for many choices' , icon: '▾' },
  { value: 'checkbox', label: 'Checkboxes', hint: 'Tick boxes — one or several choices' , icon: '☑' },
  { value: 'color_swatch', label: 'Colour swatches', hint: 'A colour chip per choice' , icon: '◐' },
  { value: 'image_swatch', label: 'Image swatches', hint: 'A thumbnail per choice' , icon: '▣' },
  { value: 'text_field', label: 'Text field', hint: 'The customer types it — an engraving, a name' , icon: 'T' },
  { value: 'textarea', label: 'Text area', hint: 'Several lines — an address, delivery notes' , icon: '¶' },
  { value: 'number_field', label: 'Number', hint: 'A quantity or size the customer types', icon: '#' },
  { value: 'range', label: 'Slider', hint: 'Drag between a minimum and a maximum', icon: '⇿' },
  { value: 'quantity', label: 'Quantity', hint: 'A count with steppers', icon: '±' },
  { value: 'date_picker', label: 'Date', hint: 'A calendar day — a delivery or event date', icon: '▦' },
  { value: 'time_picker', label: 'Time', hint: 'A time of day — a collection slot', icon: '◔' },
  { value: 'datetime_picker', label: 'Date & time', hint: 'An appointment', icon: '◵' },
  { value: 'hidden', label: 'Hidden', hint: 'A value you set — the customer never sees it', icon: '⊙' },
  {
    value: 'file_input',
    label: 'File upload',
    hint: 'The customer uploads artwork or a document',
    icon: '📎',
  },
] as const;

/**
 * What to call an option's type where a merchant reads it.
 *
 * 🔴 **The editor printed the wire value.** Under every option's label sat
 * `text_field`, `color_swatch`, `number_field` — the `presentation` string
 * exactly as it travels to the storefront. The picker two inches away had
 * already said *"Text field"*, so the same option was named twice, once in
 * merchant language and once in the database's.
 *
 * 📌 **Derived from `AUTHORABLE_TYPES`, never a second list.** A map written by
 * hand is a map that disagrees with the picker the first time a type is added
 * or renamed, and the disagreement shows up as one option described two ways on
 * one screen — which is the defect this closes.
 *
 * ⚠️ **Falls back to the raw value rather than to an empty string.** A type
 * this list does not know is still something a merchant needs to see; showing
 * nothing would hide an option's nature entirely, which is worse than showing
 * it awkwardly.
 */
export function typeLabel(presentation: string): string {
  return AUTHORABLE_TYPES.find((type) => type.value === presentation)?.label ?? presentation;
}

/*
 * ✏️ **The swatches joined this list once the value editor could set a colour or
 * an image.** They were registered in the API and deliberately absent here until
 * then — offering them earlier would have let a merchant pick "colour swatch",
 * fill in three values, publish, and get a storefront drawing plain radios,
 * because the template's validity guard drops a chip it has no colour for.
 *
 * That is the bar this list enforces: **authorable means author *and* re-open**,
 * not merely accepted by the API. `text_field` is still absent for a different
 * reason — it takes no values at all, so the value editor beside this form is
 * meaningless for it.
 */

export const optionSchema = z.object({
  key: key(MAX_OPTION_KEY),
  label: text(MAX_OPTION_LABEL, 'Give this option a label.', 'That label is too long.'),
  /**
   * The choice types this editor can round-trip, deliberately — not every type
   * the API accepts.
   *
   * The API accepts eleven presentations; offering one whose editor does not
   * exist would produce option sets **this UI cannot open again**, which is a
   * worse failure than a missing type.
   *
   * ✏️ **Widened from `z.literal('radio')` on 2026-09-03** for Phase 14's first
   * type. `dropdown` is safe to add because it needs *no new editor*: same
   * `choice`/`one` axes, same values, same per-value pricing — the merchant
   * authors it identically and only the storefront draws it differently.
   *
   * ⚠️ **The bar for joining this list is that round-trip, not registration in
   * the API.** `text_field` will be registered long before it belongs here: it
   * takes no values, so the value editor below is meaningless for it.
   */
  presentation: z.enum(AUTHORABLE_TYPES.map((type) => type.value) as [string, ...string[]]),
  isRequired: z.boolean(),

  /**
   * The character limit for a text option, or `null` for none.
   *
   * ⚠️ **Counted in graphemes, not `String.length`.** M11.1a's `measure()` is
   * the normative count on both sides — a family emoji is one character because
   * it is one mark in the engraved material — so a limit stated here means the
   * same number the server enforces and the counter displays.
   *
   * Optional and nullable: most options have no limit, and `null` is how "no
   * limit" is stored rather than a sentinel like 0.
   */
  maxLength: z.number().int().min(1, 'A limit of zero would refuse every answer.').max(5000).nullable().optional(),

  /**
   * The shortest answer this option accepts, or `null` for none.
   *
   * A workshop saying *"this is not worth setting up for one letter"*. Counted
   * in graphemes like `maxLength`, by the same normative `measure()`.
   */
  minLength: z.number().int().min(1, 'A minimum of zero is no minimum.').max(5000).nullable().optional(),
}).superRefine((option, ctx) => {
  /*
   * 🔴 **A minimum above the maximum refuses every possible answer.**
   *
   * Caught here rather than at publish: a merchant who types 20 into a field
   * already limited to 10 should be told while they are looking at both, not
   * after they have moved on. The API refuses it too — this is the courtesy,
   * that is the truth.
   */
  if (
    option.minLength !== null && option.minLength !== undefined &&
    option.maxLength !== null && option.maxLength !== undefined &&
    option.minLength > option.maxLength
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['minLength'],
      message: `A minimum of ${option.minLength} cannot fit inside a limit of ${option.maxLength}.`,
    });
  }
});

/**
 * A value, with the price a merchant typed.
 *
 * `amount` is the **string they typed**, not a number: `parseAmount` converts it
 * to minor units, string-parsed, because `(17.9 * 100)` is `1789`. Keeping the
 * raw text in the form means what they see is what they entered, and the
 * conversion happens once at submit.
 */
/**
 * Which extra fields a value needs, decided by the option's type.
 *
 * 🔴 **Extracted from the editor because the editor could not be tested.**
 * `AddValue` uses `useMutation`, so it needs a QueryClient provider that
 * `renderToStaticMarkup` cannot give it — and two mutants proved the cost:
 * setting `needsColor = false` (which re-creates the exact "swatch with no way
 * to set a colour" defect) and sending `colorHex` for every type **both passed
 * all 319 tests**.
 *
 * The rule is not UI. It is "a colour swatch needs a colour", which belongs
 * beside the schema that validates one, and is now a pure function anything can
 * assert.
 */
/**
 * Whether the merchant defines a list of values for this type.
 *
 * 🔴 **Mirrors `takesValues` in the API registry, and must not drift from it.**
 * A `text_field` has no values: the customer types the answer. Offering an "add
 * value" form for one invites a merchant to create rows the API now refuses
 * (`TYPE_TAKES_NO_VALUES`) and the storefront would ignore.
 *
 * A pure function rather than a check inside the editor, for the same reason
 * `swatchFieldsFor` is one: `AddValue` uses `useMutation` and cannot be rendered
 * by `renderToStaticMarkup`, so a rule expressed only as JSX is a rule no test
 * can mutate. Two mutants proved that cost once already — see the note below.
 *
 * `true` for anything unrecognised: a type this build does not know is far more
 * likely to be a choice type from a newer API than a valueless one, and showing
 * a form the merchant does not need is a smaller harm than hiding one they do.
 */
/** Types whose value the customer supplies rather than choosing from a list. */
const CUSTOMER_SUPPLIED = [
  'text_field',
  'textarea',
  'number_field',
  'range',
  'quantity',
  'date_picker',
  'time_picker',
  'datetime_picker',
  'hidden',
  // A customer supplies the file; there is no value list to author.
  'file_input',
];

export function takesValues(presentation: string): boolean {
  return !CUSTOMER_SUPPLIED.includes(presentation);
}

/**
 * Whether this type accepts a character limit.
 *
 * Only text does. A limit on a radio would be a number with nothing to count —
 * the customer picks from a list the merchant wrote, and its length is already
 * decided.
 */
/**
 * A key derived from a label.
 *
 * 🔴 **The key is the field merchants have no intuition for**, and the editor
 * previously asked them to invent one beside a label they had just typed. It is
 * a machine identifier — lowercase, no spaces — that a merchant never sees
 * again, so asking is a question with one sensible answer.
 *
 * Derived, not enforced: the field stays editable, because a key is permanent
 * once published and a merchant renaming *"Colour"* to *"Shade"* must not
 * silently change what the storefront resolves against.
 *
 * Returns `''` for a label with nothing usable in it — a key of `''` fails the
 * schema, which is the correct outcome rather than inventing something.
 */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_OPTION_KEY);
}

export function acceptsLength(presentation: string): boolean {
  return presentation === 'text_field' || presentation === 'textarea';
}

/**
 * The types a merchant may set to accept several answers.
 *
 * 🔴 **Mirrors the API registry, which allows `MANY` for `checkbox` alone**
 * (M18.3), and the plugin's `SelectionResolver::MANY_CAPABLE_TYPES`, which
 * keeps its own copy because AC4 makes the published document input rather
 * than authority. Three lists, one decision;
 * `bin/check-option-type-parity.sh` holds the API's against the plugin's.
 *
 * ⚠️ **Offering it for anything else would create an unsellable option.** The
 * API refuses `many` for a type its registry does not allow, so the merchant
 * would author, submit, and be handed an `INCOMPATIBLE_AXIS` error — and if it
 * somehow reached the storefront, a `radio` at `many` would sell two sizes of
 * one shirt. Measured before the plugin's guard landed.
 */
export function acceptsManyAnswers(presentation: string): boolean {
  return presentation === 'checkbox';
}

/**
 * The `validation` and `display` config an option is published with.
 *
 * 🔴 **The counter is *derived*, never a separate switch.**
 *
 * M14.4b makes `character_counter` **required whenever `max_length` is set**,
 * and names the reason: *"Silently rejecting the 21st character of an engraving
 * is a support ticket and often an abandoned cart."* A merchant checkbox could
 * express "limit, but no counter" — which is precisely the state the milestone
 * forbids — so the pair is computed here and cannot be contradicted.
 *
 * Returns `undefined` for each half that has nothing to say, so an option
 * without a limit publishes no empty objects.
 */
export function configFor(
  presentation: string,
  maxLength: number | null | undefined,
  minLength: number | null | undefined = null,
): { validation?: Record<string, unknown>; display?: Record<string, unknown> } {
  if (!acceptsLength(presentation)) {
    return {};
  }

  const validation: Record<string, unknown> = {};

  if (maxLength !== null && maxLength !== undefined) {
    validation.maxLength = maxLength;
  }

  if (minLength !== null && minLength !== undefined) {
    validation.minLength = minLength;
  }

  if (Object.keys(validation).length === 0) {
    return {};
  }

  /*
   * ⚠️ **The counter is tied to `maxLength`, not to validation in general.**
   *
   * M14.4b requires it *"whenever `max_length` is set"* — a minimum alone gives
   * a customer nothing to count *down* to, and a counter reading `3/` with
   * nothing after the slash is worse than none.
   */
  const display =
    maxLength !== null && maxLength !== undefined ? { display: { characterCounter: true } } : {};

  return { validation, ...display };
}

/**
 * The types whose options are laid out in a grid.
 *
 * 🔴 **`columns` was published, read by thirteen storefront files, and
 * authorable nowhere** (ADR-064) — one of four display fields in that state,
 * and the fourth occurrence in Phase 18 of a capability built on both sides
 * with no way for a merchant to reach it.
 *
 * ⚠️ **Mirrors `choiceDisplaySchema` in the API registry**, which is the
 * authority: `radio`, `checkbox`, `color_swatch`, `image_swatch` and
 * `dropdown`. Offering it for a text field would be a grid with one cell.
 */
export function acceptsColumns(presentation: string): boolean {
  return (
    presentation === 'radio' ||
    presentation === 'checkbox' ||
    presentation === 'color_swatch' ||
    presentation === 'image_swatch' ||
    presentation === 'dropdown'
  );
}

/**
 * How many columns an option's choices are drawn in.
 *
 * 🔴 **Bounds copied from `choiceDisplaySchema`** — `1..6`. A value outside
 * them is refused by the API, so a form that accepted 12 would let a merchant
 * submit and be handed an error rather than being told here.
 *
 * `1` means a vertical list, which is what an option publishes when it says
 * nothing — so it is sent only when the merchant asks for more.
 */
export const COLUMN_CHOICES = [1, 2, 3, 4, 5, 6] as const;

/** A tooltip's character cap, copied from `choiceDisplaySchema`. */
export const MAX_TOOLTIP = 300;

/**
 * An option's presentation extras: whether it starts folded, and its tooltip.
 *
 * 🔴 **Both were read by the storefront and settable nowhere.**
 * `collapsed_by_default` is rendered by **all fourteen** option templates, and
 * `tooltip` reaches every control through `OptionView::describedby_blocks()`.
 *
 * ⚠️ **A tooltip is announced, not hovered** — the plugin is explicit that a
 * tooltip reachable only by hover *"is invisible to a large group of
 * customers"*, so it is joined to the control by `aria-describedby` rather than
 * a `title`. That makes it help text a merchant should write as a sentence, not
 * a label, and the form says so.
 *
 * Each is sent only when it differs from what an option renders as by default,
 * so an ordinary option publishes no `display` object at all.
 */
export function presentationFor(
  collapsed: boolean,
  tooltip: string,
): { display?: Record<string, unknown> } {
  const display: Record<string, unknown> = {};

  if (collapsed) {
    display.collapsedByDefault = true;
  }

  const trimmed = tooltip.trim();

  if (trimmed !== '') {
    display.tooltip = trimmed;
  }

  return Object.keys(display).length > 0 ? { display } : {};
}

/**
 * The sizes a swatch may be drawn at.
 *
 * 🔴 **Read by `color_swatch.php` and `image_swatch.php` and settable
 * nowhere** — one of five fields M18.8's exit audit found in that state, the
 * fifth occurrence in this phase of a capability built on both sides with no
 * way for a merchant to reach it.
 *
 * ⚠️ **Offered for the two swatch types only**, though the shared choice schema
 * accepts it for all five. A radio has no swatch to size, and only those two
 * templates render the class — offering it elsewhere would be a control that
 * changes nothing.
 */
export const SWATCH_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const;

/** Whether an option is drawn as swatches, and so has a size to set. */
export function acceptsSwatchSize(presentation: string): boolean {
  return presentation === 'color_swatch' || presentation === 'image_swatch';
}

/**
 * How many values a multi-select accepts.
 *
 * 🔴 **M18.3a enforced these and left them unauthorable.** That stage closed a
 * finding — *"`minSelections`/`maxSelections` enforced nowhere"* — by teaching
 * the resolver to refuse an out-of-bounds selection, and no merchant could set
 * a bound. By its own standard it was half-delivered.
 *
 * Measured before this: a merchant with eight toppings at 1.50 who wanted
 * *"pick up to three"* had no way to say so — all eight were accepted, at 22.00.
 *
 * ⚠️ **Bounds copied from `choiceValidationSchema`**, which the API enforces:
 * `minSelections` is `0..100` and `maxSelections` is `1..100`.
 */
export const MAX_SELECTION_BOUND = 100;

/**
 * The `validation` config for a multi-select's selection counts.
 *
 * 🔴 **Only for an option that takes several answers.** A bound on a
 * single-value option is a count over one thing — the API accepts it, and
 * `SelectionResolver` enforces it, so a `min_selections: 2` on a `one` option
 * refuses every selection. Offering it there would let a merchant build an
 * unsellable option.
 *
 * Each half is sent only when set, so an unbounded multi-select publishes no
 * empty object.
 */
export function selectionBoundsFor(
  presentation: string,
  takesMany: boolean,
  min: number | null,
  max: number | null,
): { validation?: Record<string, unknown> } {
  if (!acceptsManyAnswers(presentation) || !takesMany) {
    return {};
  }

  const validation: Record<string, unknown> = {};

  if (min !== null) {
    validation.minSelections = min;
  }

  if (max !== null) {
    validation.maxSelections = max;
  }

  return Object.keys(validation).length > 0 ? { validation } : {};
}

/**
 * Whether a pair of selection bounds contradict each other.
 *
 * ⚠️ **The API cross-checks this** (`superRefine`), so a form that did not
 * would let a merchant submit and be handed *"Minimum selections (3) exceeds
 * the maximum (2)"* — an error they could have been told about before
 * submitting.
 */
export function boundsContradict(min: number | null, max: number | null): boolean {
  return min !== null && max !== null && min > max;
}

/**
 * How a price is written beside a choice.
 *
 * 🔴 **Two of the API's three** (ADR-065). `total` is `base + option`, and no
 * option template has the base price — but the blocker is not plumbing.
 * `frontend.js` listens to **no** WooCommerce variation events, deliberately,
 * because the estimate is an options *delta* and nothing it sums changes with
 * the chosen variation. A printed total would be stale the moment a customer
 * picks a size, which is a wrong price beside a control.
 *
 * ⚠️ **Offering it anyway would be worse than omitting it.** It renders as
 * `delta`, so a merchant would choose a third framing and get the first — the
 * shape ADR-063 keeps `stepped` out of the layout picker for.
 *
 * 📌 **Phase 21's server-quoted preview owns `total`**, and the plugin's own
 * runtime already says so. When it lands, the base price arrives with it and
 * this list grows.
 */
export const PRICE_FRAMINGS = [
  {
    value: 'delta',
    label: 'What it adds',
    hint: 'Beside each choice, as +10.00',
  },
  {
    value: 'hidden',
    label: 'No prices',
    hint: 'The running total still shows',
  },
] as const;

/**
 * The `display` config for a choice option's price framing.
 *
 * `delta` is what an option publishes when it says nothing, so it is sent only
 * when the merchant asks for something else — the same shape `layoutFor` takes
 * for a single column.
 */
export function priceFramingFor(
  presentation: string,
  framing: string,
): { display?: Record<string, unknown> } {
  if (!acceptsColumns(presentation) || framing === 'delta') {
    return {};
  }

  return { display: { priceDisplay: framing } };
}

/**
 * The `display` config for a swatch option's size.
 *
 * `medium` is what a swatch renders as when it says nothing — `OptionView`
 * falls back to it — so it is sent only when the merchant asks for another.
 */
export function swatchSizeFor(
  presentation: string,
  size: string,
): { display?: Record<string, unknown> } {
  if (!acceptsSwatchSize(presentation) || size === 'medium') {
    return {};
  }

  return { display: { swatchSize: size } };
}

/**
 * The `display` config for a choice option's layout.
 *
 * Returns `undefined` when there is nothing to say, so an option laid out the
 * default way publishes no empty object — the same shape `configFor` takes for
 * length rules.
 */
export function layoutFor(
  presentation: string,
  columns: number | null,
): { display?: Record<string, unknown> } {
  if (!acceptsColumns(presentation) || columns === null || columns === 1) {
    return {};
  }

  return { display: { columns } };
}

/**
 * One `display` object from every part that has something to say about it.
 *
 * 🔴 **Spreading the two results directly loses a key**, and the loss is
 * silent. `configFor` returns `{ display: { characterCounter } }` and
 * `layoutFor` returns `{ display: { columns } }`; `{ ...a, ...b }` replaces the
 * whole `display` object rather than merging it, so the counter would vanish —
 * and M14.4b makes that counter **required** whenever `maxLength` is set.
 *
 * ⚠️ **The two cannot collide today, and that is not a guarantee.** `columns`
 * is offered for choice types and `characterCounter` is derived for text ones,
 * so no option currently produces both. A helper that relies on which fields
 * happen not to overlap breaks the first time one does — which is exactly how
 * the `reorderPayloads` defect happened: correct until a second kind arrived.
 */
export function mergeConfig(
  ...parts: Array<{ validation?: Record<string, unknown>; display?: Record<string, unknown> }>
): { validation?: Record<string, unknown>; display?: Record<string, unknown> } {
  const validation: Record<string, unknown> = {};
  const display: Record<string, unknown> = {};

  parts.forEach((part) => {
    Object.assign(validation, part.validation ?? {});
    Object.assign(display, part.display ?? {});
  });

  return {
    ...(Object.keys(validation).length > 0 ? { validation } : {}),
    ...(Object.keys(display).length > 0 ? { display } : {}),
  };
}

export function swatchFieldsFor(presentation: string): {
  readonly color: boolean;
  readonly image: boolean;
} {
  return {
    color: presentation === 'color_swatch',
    image: presentation === 'image_swatch',
  };
}

/**
 * Whether a value may carry an `<optgroup>` heading (M14.3).
 *
 * ⚠️ **`dropdown` only.** Grouping is a rendering detail of a `<select>`; a radio
 * or a swatch has no equivalent, and the storefront templates for those ignore
 * `group_label` entirely. Offering the field there would let a merchant fill in
 * something that silently does nothing — the same defect as a colour swatch with
 * no way to set colours, in reverse.
 *
 * A helper rather than an inline check, following `swatchFieldsFor`: inlined in
 * the component this rule is untestable, and two mutants survived last time.
 */
export function takesGroupLabel(presentation: string): boolean {
  return presentation === 'dropdown';
}

export const valueSchema = z.object({
  valueKey: key(MAX_VALUE_KEY),
  label: text(MAX_VALUE_LABEL, 'Give this value a label.', 'That label is too long.'),
  amount: z
    .string()
    .refine((value) => value.trim() === '' || parseAmount(value).ok, {
      message: 'Enter an amount like 10.50, or leave it blank for no change.',
    }),

  /**
   * A swatch's colour, validated here as the API validates it.
   *
   * ⚠️ **The same pattern in three places, and that is deliberate.** The API's
   * DTO rejects a malformed hex, the storefront template refuses to paint one,
   * and this refuses to send one — because a colour reaches a `style` attribute,
   * where `esc_attr` alone would happily emit
   * `red; background-image:url(...)`. Validating early is a courtesy to the
   * merchant; the other two are the boundary.
   *
   * Blank is valid: a choice type that is not a swatch has no colour, and a
   * swatch with no colour renders its label alone rather than failing.
   */
  colorHex: z
    .string()
    .refine((value) => value.trim() === '' || /^#[0-9a-fA-F]{6}$/.test(value.trim()), {
      message: 'Enter a colour like #1a2b3c, or leave it blank.',
    })
    .optional(),

  /**
   * A swatch's image.
   *
   * Absolute only, matching the API's `require_protocol` — a relative URL on a
   * merchant's storefront resolves against *their* domain, which is not where
   * these images live.
   */
  imageUrl: z
    .string()
    .refine(
      (value) => value.trim() === '' || /^https?:\/\/\S+$/i.test(value.trim()),
      { message: 'Enter a full URL starting http:// or https://, or leave it blank.' },
    )
    .optional(),

  /**
   * The `<optgroup>` heading this value sits under.
   *
   * Blank is valid and means "not grouped" — the normal case, and what every
   * dropdown authored before grouping existed has. 200 characters matches the
   * API's cap and the value label it sits beside.
   */
  groupLabel: z
    .string()
    .max(MAX_VALUE_LABEL, 'That group heading is too long.')
    .optional(),
});

export type CreateSetInput = z.infer<typeof createSetSchema>;
export type RenameSetInput = z.infer<typeof renameSetSchema>;
export type GroupInput = z.infer<typeof groupSchema>;
export type OptionInput = z.infer<typeof optionSchema>;
export type ValueInput = z.infer<typeof valueSchema>;

export const OPTION_SET_LIMITS = {
  MAX_SET_NAME,
  MAX_GROUP_LABEL,
  MAX_GROUP_DESCRIPTION,
  MAX_OPTION_KEY,
  MAX_OPTION_LABEL,
  MAX_VALUE_KEY,
  MAX_VALUE_LABEL,
  KEY_PATTERN,
} as const;

/**
 * A numeric field a merchant types, where empty means "unset".
 *
 * 🔴 **The input is a STRING and the payload wants a number-or-null.** The
 * editor does this by hand in six places —
 * `text.trim() === '' ? null : Number(text)` — and hand-written coercion is
 * where a `0` becomes `null`, because `Number('') === 0` and `'0'` is falsy as
 * a string only if you test it wrongly. Modelled once, here.
 *
 * ⚠️ **`z.coerce.number()` is deliberately NOT used.** It maps `''` to `0`,
 * which for `minLength` means "refuse every answer" rather than "no minimum" —
 * the exact defect `optionSchema`'s own message warns about.
 */
const optionalCount = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine((value) => value === null || Number.isInteger(value), 'Whole numbers only.')
    .refine((value) => value === null || value >= 1, 'Zero would refuse every answer.')
    .refine((value) => value === null || value <= max, 'That number is too large.');

/**
 * The rest of what the option form collects (20-2b).
 *
 * 📌 **Separate from `optionSchema`, not merged into it.** That schema is the
 * API's shape — `key`, `label`, `presentation`, `isRequired`, `maxLength` —
 * and is used where a payload is validated. These seven are *form* fields that
 * feed the config helpers (`layoutFor`, `priceFramingFor`, `swatchSizeFor`,
 * `presentationFor`, `selectionBoundsFor`) rather than the payload directly.
 * Merging them would make every caller of `optionSchema` carry fields the API
 * never sees.
 *
 * 🔴 **PENDING, not dead — and nothing in the build can tell the difference.**
 * Its caller is the `react-hook-form` migration of `AddOption` (20-2c), which
 * has not landed; today it is imported by its own tests alone.
 * `check-reachable` cannot see this: that gate works at **module** level, and
 * this file is reachable through its other exports. Its docblock records the
 * same trap — *"three rule modules sat with no caller… nothing here could tell
 * pending from dead, and a reader had no way to know which."*
 *
 * So it is written here instead. If the migration is abandoned, **delete this
 * schema** rather than leave it looking like an oversight.
 *
 * ⚠️ **`keyTouched` is absent and must stay absent.** It records whether a
 * merchant has edited the key so the label can stop auto-filling it — UI
 * bookkeeping, not data. A form model that carries it would validate it, reset
 * it, and eventually send it.
 */
export const optionFormExtrasSchema = z.object({
  /** Several answers rather than one. Immutable after creation. */
  takesMany: z.boolean(),

  /** Columns the choices are drawn in; `1` is a vertical list. */
  columns: z.number().int().min(1).max(COLUMN_CHOICES[COLUMN_CHOICES.length - 1]),

  /** How a price is written beside each choice. */
  priceFraming: z.enum(PRICE_FRAMINGS.map((framing) => framing.value) as [string, ...string[]]),

  /** Swatch dimensions, for the two swatch types. */
  swatchSize: z.enum(SWATCH_SIZES.map((size) => size.value) as [string, ...string[]]),

  /** Rendered collapsed by default. */
  collapsed: z.boolean(),

  /** Help text shown beside the label. */
  tooltip: z.string().trim().max(MAX_TOOLTIP, 'That help text is too long.'),

  /** Selection bounds, for an option that takes several answers. */
  minSelections: optionalCount(MAX_SELECTION_BOUND),
  maxSelections: optionalCount(MAX_SELECTION_BOUND),
});

/**
 * Every field the option form holds, as one schema (20-2c).
 *
 * 🔴 **The form's shape, which is NOT the API's.** `optionSchema` validates the
 * payload and is used wherever a request is checked. This is what `useForm`
 * needs: the same identity fields, the seven that feed the config helpers, and
 * the four numeric fields **as the strings a merchant types**.
 *
 * ⚠️ **The `*Text` fields stay strings here.** They are converted at
 * payload-build time by the nine `accepts*(presentation)` guards, which is what
 * keeps a limit typed for a text field out of a radio's payload. Coercing them
 * in the schema would move that decision away from the guards and break the
 * behaviour `add-option.payload.test.tsx` pins.
 *
 * ⚠️ **Declared, not reached for through `.shape`.** `optionSchema` ends in a
 * `.superRefine`, which makes it a `ZodEffects` with no `.shape` at all — so the
 * identity fields are built from the same helpers it uses. The helpers are the
 * shared definition; the two schemas are two views of them.
 *
 * 📌 **`keyTouched` is absent**, for the reason `optionFormExtrasSchema`
 * records: it is UI bookkeeping, not data.
 */
export const optionFormSchema = z.object({
  key: key(MAX_OPTION_KEY),
  label: text(MAX_OPTION_LABEL, 'Give this option a label.', 'That label is too long.'),
  presentation: z.enum(AUTHORABLE_TYPES.map((type) => type.value) as [string, ...string[]]),
  isRequired: z.boolean(),

  takesMany: z.boolean(),
  columns: z.number().int().min(1).max(COLUMN_CHOICES[COLUMN_CHOICES.length - 1]),
  priceFraming: z.enum(PRICE_FRAMINGS.map((framing) => framing.value) as [string, ...string[]]),
  swatchSize: z.enum(SWATCH_SIZES.map((size) => size.value) as [string, ...string[]]),
  collapsed: z.boolean(),
  tooltip: z.string().trim().max(MAX_TOOLTIP, 'That help text is too long.'),

  minSelText: z.string(),
  maxSelText: z.string(),
  maxLengthText: z.string(),
  minLengthText: z.string(),
}).superRefine((values, ctx) => {
  /*
   * 🔴 **The same cross-field rule `optionSchema` carries, and leaving it out
   * was a regression.** `optionSchema.superRefine` reports *"A minimum of 50
   * cannot fit inside a limit of 10"* against `minLength`, and the form used to
   * render it because `issue()` read that parse directly. Once `issue()` moved
   * to `formState`, the message vanished — the form schema had no such rule.
   * Measured before and after: the text was present pre-migration and absent
   * after.
   *
   * ⚠️ **Read from the typed strings**, because that is what this schema holds.
   * An empty field means "no bound" and cannot contradict anything.
   */
  const min = values.minLengthText.trim() === '' ? null : Number(values.minLengthText);
  const max = values.maxLengthText.trim() === '' ? null : Number(values.maxLengthText);

  if (min !== null && max !== null && min > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['minLength'],
      message: `A minimum of ${min} cannot fit inside a limit of ${max}.`,
    });
  }
});

/** What `useForm` holds for the option form. */
export type OptionFormValues = z.infer<typeof optionFormSchema>;
