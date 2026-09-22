import { describe, expect, it } from 'vitest';

import { AUTHORABLE_TYPES } from '@/lib/schemas/option-sets';

import { answerInput } from './answer-input';

describe('answerInput', () => {
  it.each(['radio', 'dropdown', 'checkbox', 'color_swatch', 'image_swatch'])(
    '%s is answered by choosing a value',
    (presentation) => {
      expect(answerInput(presentation)).toBe('choice');
    },
  );

  it.each(['text_field', 'textarea'])('%s is answered by typing', (presentation) => {
    expect(answerInput(presentation)).toBe('text');
  });

  it.each(['number_field', 'quantity'])('%s is answered by a number', (presentation) => {
    expect(answerInput(presentation)).toBe('number');
  });

  /**
   * 🔴 **A range is a slider, not a spinbox.** The storefront renders
   * `type="range"` with an `<output>` readout; a customer drags rather than
   * types.
   *
   * ✏️ **This asserted `'number'` until an audit caught it.** Making the preview
   * answerable regressed this one type — the inert `OptionPreview` it replaced
   * had always drawn a real slider. The values agreed, so ADR-109's
   * numbers-only comparison would have certified it exact.
   */
  it('range is answered by dragging a slider', () => {
    expect(answerInput('range')).toBe('range');
  });

  it('date, time and datetime each get their own control', () => {
    expect(answerInput('date_picker')).toBe('date');
    expect(answerInput('time_picker')).toBe('time');
    expect(answerInput('datetime_picker')).toBe('datetime');
  });

  /**
   * `hidden` answers itself from `default_value` (`evaluableAnswers`), and a
   * file a customer has not uploaded is not something a preview can invent.
   */
  it.each(['hidden', 'file_input'])('%s is not answered by the customer here', (presentation) => {
    expect(answerInput(presentation)).toBe('none');
  });

  /**
   * ⚠️ **An unknown type gets no control rather than a guessed one** — visible
   * and wrong-looking beats silently mis-rendered, the same choice the
   * serializer makes for an unrecognised price type.
   */
  it('gives an unrecognised type no control', () => {
    expect(answerInput('not_a_real_type')).toBe('none');
  });

  /**
   * 🔴 **Every authorable type is accounted for.** A type added to the registry
   * and forgotten here would fall to `none` and silently become unanswerable —
   * which is the defect this file was written to fix, returning by a different
   * door.
   */
  it('classifies every authorable type', () => {
    const unhandled = AUTHORABLE_TYPES.filter(
      (type) => answerInput(type.value) === 'none' && !['hidden', 'file_input'].includes(type.value),
    );

    expect(unhandled).toEqual([]);
  });
});
