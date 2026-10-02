import { describe, expect, it } from 'vitest';

import { TEXT_FONTS } from '@shared/design/design-geometry.types';
import {
  ADVANCE_RATIO_EPSILON,
  TEXT_FONT_AXES,
  advanceRatioChanged,
  fontShorthand,
  googleFontsHref,
  measureAdvanceRatio,
} from './text-fonts';

describe('the axis map', () => {
  /*
   * 🔴 **A family with no axis entry would be requested as a bare name.** That
   * loads only its regular face, so bold and italic silently fall back — and
   * the measured advance ratio is then taken from the wrong glyphs.
   */
  it('covers every curated family', () => {
    expect(Object.keys(TEXT_FONT_AXES).sort()).toEqual([...TEXT_FONTS].sort());
  });

  it('declares no axis for a family that publishes only a regular face', () => {
    expect(TEXT_FONT_AXES.Pacifico).toBe('');
  });

  /*
   * ⚠️ **Measured against the live API, not assumed.** Oswald and Dancing
   * Script publish no italic; requesting one returns HTTP 200 and omits the
   * face, so nothing would fail loudly.
   */
  it.each(['Oswald', 'Dancing Script'] as const)(
    'does not request italic for %s, which publishes none',
    (font) => {
      expect(TEXT_FONT_AXES[font]).not.toContain('ital');
    },
  );
});

describe('googleFontsHref', () => {
  it('asks for every curated family in one request', () => {
    const href = googleFontsHref();

    for (const font of TEXT_FONTS) {
      expect(href).toContain(`family=${font.replaceAll(' ', '+')}`);
    }
  });

  /*
   * 🔴 **A space in a family name must become `+`.** A raw space produces a URL
   * the API rejects — and a rejected request is HTTP 400 for the WHOLE
   * stylesheet, which loads none of the eight.
   */
  it('escapes the space in a two-word family', () => {
    expect(googleFontsHref()).toContain('family=Open+Sans');
    expect(googleFontsHref()).not.toContain('family=Open Sans');
  });

  it('asks the browser to render with a fallback while the font loads', () => {
    expect(googleFontsHref()).toContain('display=swap');
  });
});

describe('fontShorthand', () => {
  it.each([
    ['regular', false, false, '400 100px "Roboto"'],
    ['bold', true, false, '700 100px "Roboto"'],
    ['italic', false, true, 'italic 400 100px "Roboto"'],
    ['bold italic', true, true, 'italic 700 100px "Roboto"'],
  ])('spells %s', (_n, bold, italic, expected) => {
    expect(fontShorthand('Roboto', bold, italic, 100)).toBe(expected);
  });

  /* ⚠️ Quoted, or a two-word family parses as two values and the rule is dropped. */
  it('quotes a two-word family', () => {
    expect(fontShorthand('Open Sans', false, false, 100)).toContain('"Open Sans"');
  });
});

describe('measureAdvanceRatio', () => {
  /*
   * 📌 **jsdom has no text metrics**, so this returns null here — which is the
   * documented fallback path, not a failure. The real measurement is browser
   * work and is verified there.
   */
  it('returns null rather than guessing when nothing can be measured', () => {
    expect(measureAdvanceRatio('abc', 'Roboto', false, false)).toBeNull();
  });
});

describe('advanceRatioChanged', () => {
  /*
   * 🔴 **Without a threshold the measurement loops**: storing re-renders, which
   * re-measures, which stores again, and float noise means it never settles.
   */
  it('ignores a move smaller than the epsilon', () => {
    expect(advanceRatioChanged(0.5 + ADVANCE_RATIO_EPSILON / 2, 0.5)).toBe(false);
  });

  it('accepts a move larger than the epsilon', () => {
    expect(advanceRatioChanged(0.5 + ADVANCE_RATIO_EPSILON * 2, 0.5)).toBe(true);
  });

  it('accepts the first measurement, when nothing is stored', () => {
    expect(advanceRatioChanged(0.54, undefined)).toBe(true);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -0.2],
  ])('refuses an unusable %s measurement', (_n, measured) => {
    expect(advanceRatioChanged(measured, 0.5)).toBe(false);
  });
});
