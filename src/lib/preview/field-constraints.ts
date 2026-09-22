/**
 * The constraints a customer's browser enforces, as the storefront emits them.
 *
 * 🔴 **The preview read one of seventeen validation keys.** `max_length` reached
 * the markup and everything else — `min`, `max`, `step`, `integer_only` — was
 * converted by `toPublishedValidation` and thrown away. A merchant setting
 * min 1 / max 100 on a quantity saw **no constraint at all** in the preview,
 * while the storefront emits real HTML attributes the browser acts on.
 *
 * ## What the storefront does NOT emit, and why that is not a gap
 *
 * ⚠️ **Selection bounds and date bounds are server-enforced only.** No template
 * emits `min_selections`, `max_selections`, `min_date` or `max_date` — verified
 * against `rendered-fixtures.json`, where a `date_picker` carries `required` and
 * nothing else despite the fixture setting both date rules. A preview that
 * invented them would disagree with the shop in the direction that matters most:
 * showing a customer a limit their browser will not apply.
 *
 * So this mirrors exactly what reaches a browser, no more.
 */
export interface FieldConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly maxLength?: number;
}

/** A validation value as a number, or undefined when it is not one. */
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read an option's published `validation` into browser constraints.
 *
 * 🔴 **`integer_only` is expressed as `step="1"`**, which is the storefront's own
 * wording — there is no `integer` attribute, and a browser that does not know
 * the rule still refuses a fraction. An explicit `step` wins, because a merchant
 * who set one meant it.
 *
 * 🔴 **And `quantity` always steps by one, whatever the merchant set.** Three
 * numeric templates, **two behaviours**: `number_field` and `range` fall back to
 * `integer_only`, while `quantity.php` falls back to `'1'` **unconditionally**,
 * because a quantity is inherently whole. Confirmed in the rendered fixture,
 * where a quantity carries `step="1"` though its validation set neither `step`
 * nor `integer_only`.
 *
 * ✏️ **This function took no `presentation` at first**, so it was structurally
 * incapable of the distinction: a merchant previewing a quantity saw a field
 * accepting `2.5` that the storefront refuses. `min` and `max` are identical
 * across all three templates — only `step` diverges, and only here.
 *
 * ⚠️ **`step` must be greater than zero and `max_length` greater than zero**,
 * both as the templates test them: `step="0"` makes a number input refuse every
 * value, and `maxlength="0"` refuses every character.
 *
 * @param validation The option's validation, in the published dialect.
 * @param presentation The option's type, because `quantity` steps differently.
 */
export function fieldConstraints(
  validation: Record<string, unknown> | null | undefined,
  presentation?: string,
): FieldConstraints {
  const rules = validation ?? {};

  const step = numeric(rules.step);
  const maxLength = numeric(rules.max_length);

  /*
   * A quantity is whole by nature, so the storefront gives it `step="1"` with no
   * rule set at all. The other numeric types only step when told to.
   */
  const impliedStep = presentation === 'quantity' || rules.integer_only ? 1 : undefined;

  return {
    min: numeric(rules.min),
    max: numeric(rules.max),
    step: step !== undefined && step > 0 ? step : impliedStep,
    maxLength: maxLength !== undefined && maxLength > 0 ? maxLength : undefined,
  };
}
