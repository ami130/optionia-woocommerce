/**
 * How a customer answers an option, for the types that carry no values.
 *
 * 🔴 **Nine of fifteen types could not be answered in the preview at all.**
 * `OptionPreview` is deliberately inert — *"a likeness, not the storefront"* —
 * and the set-scope preview answered options only by choosing a **value**. So a
 * rule reading *"engraving text is not empty"*, the most common conditional
 * pattern there is, could never fire: the merchant had nothing to type into, the
 * condition stayed false, and a correct rule looked broken.
 *
 * The same failure shape as a group-hide rule doing nothing (M21.3'): a merchant
 * rewrites something that was right.
 *
 * ⚠️ **And `per_char` prices what a customer types**, so option-level pricing
 * could not be shown either — with no input there is nothing to price.
 */
export type AnswerInput =
  | 'choice'
  | 'text'
  | 'number'
  | 'range'
  | 'date'
  | 'time'
  | 'datetime'
  | 'none';

const CHOICE = ['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'];

/**
 * What kind of control answers this option.
 *
 * Grouped the way the plugin groups its templates, so a preview asks the same
 * question the storefront does. `hidden` answers itself from `default_value`
 * (`evaluableAnswers`) and `file_input` cannot be previewed at all — a file a
 * customer has not uploaded is not something a preview can invent.
 */
export function answerInput(presentation: string): AnswerInput {
  if (CHOICE.includes(presentation)) {
    return 'choice';
  }

  if (presentation === 'text_field' || presentation === 'textarea') {
    return 'text';
  }

  /*
   * 🔴 **A range is a slider, not a spinbox.** The storefront renders
   * `type="range"` with an `<output>` readout beside it, and a customer drags
   * rather than types.
   *
   * ✏️ **The first interactive preview drew it as a number box** — making the
   * preview answerable (F32) *regressed* this one type, because the inert
   * `OptionPreview` it replaced had always drawn a real slider. The values
   * agreed, so a numbers-only fidelity comparison (ADR-109) would have certified
   * it as exact.
   */
  if (presentation === 'range') {
    return 'range';
  }

  if (presentation === 'number_field' || presentation === 'quantity') {
    return 'number';
  }

  if (presentation === 'date_picker') {
    return 'date';
  }

  if (presentation === 'time_picker') {
    return 'time';
  }

  if (presentation === 'datetime_picker') {
    return 'datetime';
  }

  /*
   * `hidden` and `file_input`, and anything a later build adds. Returning
   * `none` rather than guessing a control keeps an unknown type visible and
   * wrong-looking instead of silently mis-rendered — the same choice the
   * serializer makes for an unrecognised price type.
   */
  return 'none';
}

/** The `type` attribute for an input kind, where one applies. */
export const INPUT_TYPES: Readonly<Record<string, string>> = {
  text: 'text',
  number: 'number',
  range: 'range',
  date: 'date',
  time: 'time',
  datetime: 'datetime-local',
};
