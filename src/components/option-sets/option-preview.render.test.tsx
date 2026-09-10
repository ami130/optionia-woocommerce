import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OptionPreview } from './option-preview';
import { AUTHORABLE_TYPES } from '@/lib/schemas/option-sets';

/**
 * 🔴 **The preview is the answer to "did I pick the right control?"**
 *
 * A merchant choosing between radio and dropdown is choosing between two
 * pictures they cannot otherwise see until publish → assign → open a storefront.
 * If the preview drew the wrong shape it would be worse than no preview: it
 * would answer the question confidently and wrongly.
 *
 * Rendered rather than reasoned about — the swatch mutants that survived an
 * earlier stage did so precisely because the rule lived in JSX no test reached.
 */
const html = (presentation: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <OptionPreview label="Colour" presentation={presentation} isRequired={false} maxLength={null} {...extra} />,
  );

describe('OptionPreview', () => {
  it.each([
    ['radio', 'type="radio"'],
    ['dropdown', '<select'],
    ['checkbox', 'type="checkbox"'],
    ['text_field', 'placeholder="Type here'],
    ['textarea', '<textarea'],
    ['number_field', 'type="number"'],
  ])('draws %s as %s', (presentation, marker) => {
    expect(html(presentation)).toContain(marker);
  });

  /** A colour swatch paints actual colour; that is what makes it a swatch. */
  it('paints colour chips for a colour swatch', () => {
    const out = html('color_swatch');
    expect(out).toContain('background-color');
    expect(out).toContain('#cc0000');
  });

  /** An image swatch shows tiles, and must not paint colour. */
  it('draws tiles for an image swatch, not colours', () => {
    const out = html('image_swatch');
    expect(out).not.toContain('#cc0000');
    expect(out).toContain('rounded');
  });

  /**
   * ⚠️ **Every authorable type must draw something.**
   *
   * A type added to the picker without a preview branch falls to the default and
   * silently draws radio buttons — a merchant would pick "Number" and see a list
   * of choices. This fails when that happens.
   */
  it.each(AUTHORABLE_TYPES.map((t) => t.value))('%s renders without falling through', (value) => {
    const out = html(value);
    const isChoice = ['radio', 'checkbox'].includes(value);

    expect(out.length).toBeGreaterThan(50);
    if (!isChoice) {
      expect(out, `${value} fell through to the radio default`).not.toContain('First choice');
    }
  });

  it('marks a required option', () => {
    expect(html('radio', { isRequired: true })).toContain('*');
  });

  it('shows the counter only when a limit is set on a text type', () => {
    expect(html('text_field', { maxLength: 20 })).toContain('0/20');
    expect(html('radio', { maxLength: 20 })).not.toContain('0/20');
  });

  it('falls back to a placeholder name before the merchant types one', () => {
    expect(
      renderToStaticMarkup(
        <OptionPreview label="" presentation="radio" isRequired={false} maxLength={null} />,
      ),
    ).toContain('Your option');
  });
});
