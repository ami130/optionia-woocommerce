import type { ValidationKind } from './option-validation';

/**
 * How an option is drawn, and the one setting the dashboard must **derive**.
 *
 * ## The contract the plugin states
 *
 * 🔴 **`character_counter` is derived from the length limit, never offered.**
 * `templates/options/text_field.php` says so outright: *"The dashboard derives
 * `character_counter` from the limit rather than offering it as a separate
 * switch, so the two cannot disagree."*
 *
 * Making `maxLength` authorable without honouring that produced exactly the
 * defect M14.4b names — *"silently rejecting the 21st character of an engraving
 * is a support ticket and often an abandoned cart."* A merchant set a limit of
 * twenty and the customer met it with no warning.
 *
 * ⚠️ **A switch would be worse than nothing here.** A merchant could turn the
 * counter off while a limit stood, which is the disagreement the plugin's
 * comment exists to prevent — and the template still checks both fields
 * precisely because an older dashboard could publish one without the other.
 */

/** Settings a merchant chooses, per option kind. */
export type DisplayField = 'columns' | 'priceDisplay' | 'tooltip';

/** The form's fields, as strings that may be blank. */
export interface DisplayFields {
  columns: string;
  priceDisplay: string;
  tooltip: string;
}

/**
 * Which settings this presentation offers.
 *
 * ⚠️ **`columns` is a choice-grid setting** — `choiceDisplaySchema` has it and
 * `textDisplaySchema` does not, and both are `.strict()`, so offering it on a
 * text option would be a form that fails on save.
 *
 * 🔴 **`characterCounter` is never in this list.** It is derived.
 */
export function optionDisplayFields(presentation: string): DisplayField[] {
  const choice =
    presentation === 'radio' ||
    presentation === 'dropdown' ||
    presentation === 'checkbox' ||
    presentation === 'color_swatch' ||
    presentation === 'image_swatch';

  return choice ? ['columns', 'priceDisplay', 'tooltip'] : ['priceDisplay', 'tooltip'];
}

/**
 * Apply the derived counter to whatever display settings exist.
 *
 * 📌 **Takes the validation it derives from**, so the two can never disagree:
 * one call site sets both, and the counter follows the limit rather than a
 * merchant remembering to match them.
 *
 * ⚠️ **Only for a text option.** A number has no characters to count, and
 * `numberOptionPricing`'s display schema has no such field — sending one to a
 * `.strict()` schema is a refused write.
 */
export function deriveDisplay(
  kind: ValidationKind | null,
  validation: Record<string, unknown> | null | undefined,
  display: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...(display ?? {}) };

  if (kind === 'length') {
    /*
     * 🔴 **A ceiling, not any limit.** `minLength` alone gives the customer
     * nothing to count towards, and a counter reading `3/` would be noise.
     */
    next.characterCounter = typeof validation?.maxLength === 'number';
  } else {
    delete next.characterCounter;
  }

  return Object.keys(next).length === 0 ? null : next;
}

/** Read stored display settings back into form fields. */
export function readOptionDisplay(
  display: Record<string, unknown> | null | undefined,
): DisplayFields {
  return {
    columns: typeof display?.columns === 'number' ? String(display.columns) : '',
    priceDisplay: typeof display?.priceDisplay === 'string' ? display.priceDisplay : '',
    tooltip: typeof display?.tooltip === 'string' ? display.tooltip : '',
  };
}

export type DisplayParse =
  | { ok: true; display: Record<string, unknown> | null }
  | { ok: false; message: string };

/**
 * Build the stored display object from the form, keeping what it does not edit.
 *
 * 🔴 **`.strict()` again** — anything stored that this form does not show must
 * survive, or a merchant setting a tooltip would delete a `swatchSize` they set
 * elsewhere.
 */
export function parseOptionDisplay(
  presentation: string,
  fields: DisplayFields,
  stored: Record<string, unknown> | null | undefined,
): DisplayParse {
  const offered = optionDisplayFields(presentation);
  const next: Record<string, unknown> = { ...(stored ?? {}) };

  if (offered.includes('columns')) {
    const text = fields.columns.trim();

    if (text === '') {
      delete next.columns;
    } else if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 6) {
      return { ok: false, message: 'Columns must be a whole number from 1 to 6.' };
    } else {
      next.columns = Number(text);
    }
  }

  if (fields.priceDisplay.trim() === '') {
    delete next.priceDisplay;
  } else {
    next.priceDisplay = fields.priceDisplay.trim();
  }

  const tooltip = fields.tooltip.trim();

  if (tooltip === '') {
    delete next.tooltip;
  } else if (tooltip.length > 300) {
    return { ok: false, message: 'That tooltip is too long.' };
  } else {
    next.tooltip = tooltip;
  }

  return { ok: true, display: Object.keys(next).length === 0 ? null : next };
}
