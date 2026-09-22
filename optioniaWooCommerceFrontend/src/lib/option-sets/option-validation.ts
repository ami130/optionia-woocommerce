/**
 * The limits a customer's answer must satisfy.
 *
 * ## Why this closes a real hole rather than adding a field
 *
 * 🔴 **The storefront has always enforced these, and no merchant could set
 * them.** The audit that added option wording let a merchant write *"Up to 20
 * characters"* beneath an engraving field — and not enforce twenty. Advisory
 * text with no rule behind it is worse than neither: the customer reads a limit
 * that does not hold, and the order arrives with forty.
 *
 * ## What this deliberately does not author
 *
 * ⚠️ **`pattern`, `allowedCharset` and `blocklist` are out of scope**, and
 * `pattern` is the reason. It is the one rule a merchant writes **as code**,
 * which M14.4 calls a security boundary: it runs on every add-to-cart, so a
 * catastrophically backtracking expression is a denial-of-service vector.
 * `patternsAreSafe` checks its shape at publish. Offering it in a text box
 * beside two number fields would give a dangerous field the weight of a
 * convenience.
 *
 * 🔴 **But stored values of those fields SURVIVE an edit here.** The schemas are
 * `.strict()`, so sending a validation object without them would delete rules a
 * merchant never touched — a length limit silently removing a pattern.
 */

/** Which bounds an option's answer takes, or `null` when it takes none. */
export type ValidationKind = 'length' | 'range';

/** The two fields the form holds, as strings that may be half-typed. */
export interface BoundFields {
  lower: string;
  upper: string;
}

export type ValidationParse =
  | { ok: true; validation: Record<string, unknown> | null }
  | { ok: false; message: string };

/** The API's cap on a text length, mirrored so the form refuses before the wire. */
const MAX_LENGTH = 5000;

/**
 * What kind of bound this presentation takes.
 *
 * ⚠️ **A choice option's answer is a value id** — there is nothing to bound, and
 * `choiceValidationSchema` accepts no length or range. Offering one would be a
 * form that fails on save.
 */
export function optionValidationKind(presentation: string): ValidationKind | null {
  if (presentation === 'text_field' || presentation === 'textarea') {
    return 'length';
  }

  if (presentation === 'number_field' || presentation === 'range' || presentation === 'quantity') {
    return 'range';
  }

  return null;
}

/** A number as typed, or `null` when the field is blank or malformed. */
const parseBound = (input: string, integerOnly: boolean): number | null | 'bad' => {
  const text = input.trim();

  if (text === '') {
    return null;
  }

  const pattern = integerOnly ? /^\d+$/ : /^-?\d+(?:\.\d+)?$/;

  return pattern.test(text) ? Number(text) : 'bad';
};

/**
 * Build the stored validation object, keeping whatever this form does not edit.
 *
 * 📌 **`stored` is merged, not replaced.** That is the whole reason this takes
 * it: a merchant setting a length limit must not lose the `pattern` they set
 * last week, and `.strict()` means an omitted field is a deleted field.
 */
export function parseOptionValidation(
  kind: ValidationKind,
  fields: BoundFields,
  stored: Record<string, unknown> | null | undefined,
): ValidationParse {
  const integerOnly = kind === 'length';
  const lower = parseBound(fields.lower, integerOnly);
  const upper = parseBound(fields.upper, integerOnly);

  if (lower === 'bad' || upper === 'bad') {
    return {
      ok: false,
      message: integerOnly
        ? 'Lengths must be whole numbers, or blank.'
        : 'Bounds must be numbers, or blank.',
    };
  }

  if (integerOnly && ((lower ?? 0) > MAX_LENGTH || (upper ?? 0) > MAX_LENGTH)) {
    return { ok: false, message: `The API accepts lengths up to ${MAX_LENGTH}.` };
  }

  /*
   * 🔴 **The API's own cross-field rule.** `numberValidationSchema` refuses a
   * minimum above a maximum, and so does the text one — a rule neither bound
   * shows on its own.
   */
  if (lower !== null && upper !== null && lower > upper) {
    return {
      ok: false,
      message: `The minimum (${lower}) is above the maximum (${upper}).`,
    };
  }

  /* Everything this form does not edit, carried through untouched. */
  const rest = { ...(stored ?? {}) };
  const [lowerKey, upperKey] = kind === 'length' ? ['minLength', 'maxLength'] : ['min', 'max'];

  delete rest[lowerKey!];
  delete rest[upperKey!];

  const next: Record<string, unknown> = { ...rest };

  if (lower !== null) {
    next[lowerKey!] = lower;
  }

  if (upper !== null) {
    next[upperKey!] = upper;
  }

  /* Nothing left at all means the option has no rules — cleared, not `{}`. */
  return { ok: true, validation: Object.keys(next).length === 0 ? null : next };
}

/** Read stored bounds back into form fields. */
export function readOptionValidation(
  kind: ValidationKind,
  validation: Record<string, unknown> | null | undefined,
): BoundFields {
  const [lowerKey, upperKey] = kind === 'length' ? ['minLength', 'maxLength'] : ['min', 'max'];
  const show = (key: string): string =>
    typeof validation?.[key] === 'number' ? String(validation[key]) : '';

  return { lower: show(lowerKey!), upper: show(upperKey!) };
}
