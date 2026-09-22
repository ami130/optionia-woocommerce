import { describe, expect, it } from 'vitest';

import { dividerStyle, styleTokens } from './option-view';

/**
 * 🔴 **The preview's half of "renders identically in preview and storefront".**
 *
 * Phase 21c's exit requires it, and two validators disagreeing about one value
 * is exactly how that stops being true. Every case here is one the plugin's
 * `OptionStylesTest` also covers, deliberately: the two are twins, and a rule
 * that holds on one side and not the other is the defect.
 */
describe('styleTokens', () => {
  it('emits the four tokens a merchant configured', () => {
    expect(
      styleTokens({
        display: {
          accent_color: '#3858e9',
          border_radius: 6,
          spacing: 10,
          swatch_px: 40,
        },
      }),
    ).toEqual({
      '--optionia-accent': '#3858e9',
      '--optionia-radius': '6px',
      '--optionia-gap': '10px',
      '--optionia-swatch': '40px',
    });
  });

  /**
   * ⚠️ **`undefined`, not `{}`.** React omits the attribute entirely, where an
   * empty object still emits `style=""` — markup claiming a decision nobody made.
   */
  it('returns undefined when nothing validates', () => {
    expect(styleTokens({})).toBeUndefined();
    expect(styleTokens({ display: null })).toBeUndefined();
    expect(styleTokens({ display: {} })).toBeUndefined();
  });

  /**
   * 🔴 **The injection case.** A colour that closes its declaration and opens
   * another must never reach a style attribute — in the preview as much as on
   * the storefront, because a merchant testing here would see it work.
   */
  it.each([
    ['declaration break', '#3858e9; background: url(//evil)'],
    ['quote break', '#3858e9"'],
    ['expression', 'var(--x)'],
    ['url', 'url(//evil)'],
    ['named', 'red'],
    ['rgb function', 'rgb(255,0,0)'],
    ['shorthand', '#f00'],
    ['not hex', '#gggggg'],
    ['empty', ''],
  ])('refuses a hostile accent colour: %s', (_label, hostile) => {
    expect(styleTokens({ display: { accent_color: hostile } })).toBeUndefined();
  });

  /**
   * ⚠️ **Out of range is dropped, not clamped** — clamping invents a value the
   * merchant did not author (M9.6).
   */
  it.each([
    ['border_radius', -1],
    ['border_radius', 25],
    ['spacing', -1],
    ['spacing', 49],
    ['swatch_px', 15],
    ['swatch_px', 129],
  ])('drops %s of %s', (key, value) => {
    expect(styleTokens({ display: { [key]: value } })).toBeUndefined();
  });

  /** A float pixel is not a pixel count, and `4.5px` renders. */
  it('drops a fractional value', () => {
    expect(styleTokens({ display: { border_radius: 4.5 } })).toBeUndefined();
  });

  /** `"4"` is what a form sends when nobody coerced it. */
  it('drops a numeric string', () => {
    expect(styleTokens({ display: { border_radius: '4' } })).toBeUndefined();
    expect(styleTokens({ display: { spacing: '4; color: red' } })).toBeUndefined();
  });

  /**
   * 🔴 **One bad token does not cost the others** — a stale document must not
   * read as a styling bug.
   */
  it('keeps the good tokens beside a bad one', () => {
    expect(
      styleTokens({
        display: {
          accent_color: 'red; background: url(//evil)',
          border_radius: 6,
          spacing: 10,
        },
      }),
    ).toEqual({
      '--optionia-radius': '6px',
      '--optionia-gap': '10px',
    });
  });

  /** A malformed `display` must not throw — a hand-edited row can hold anything. */
  it('ignores a malformed display block', () => {
    expect(styleTokens({ display: undefined })).toBeUndefined();
    expect(
      styleTokens({ display: { accent_color: 42, border_radius: 'wide' } as never }),
    ).toBeUndefined();
  });
});

describe('dividerStyle', () => {
  /**
   * 🔴 **The preview's half of divider parity** (M21c.5, F35). Every case here
   * is one the plugin's `DividerStyleTest` also covers: the two are twins, and
   * a style honoured on one surface and not the other is the defect.
   */
  it.each(['solid', 'dashed', 'dotted'])('keeps the supported style %s', (style) => {
    expect(dividerStyle({ display: { style } })).toBe(style);
  });

  /**
   * ⚠️ **The styles ADR-113 declined, and values no document should carry.**
   * Each falls back to `solid`, which is what the storefront does.
   */
  it.each([
    ['double', 'double'],
    ['groove', 'groove'],
    ['wave', 'wave'],
    ['class break', 'solid" onload="alert(1)'],
    ['uppercase', 'DASHED'],
    ['padded', ' dashed '],
    ['empty', ''],
  ])('falls back to solid for %s', (_label, style) => {
    expect(dividerStyle({ display: { style } })).toBe('solid');
  });

  it('falls back to solid for a non-string style', () => {
    expect(dividerStyle({ display: { style: 3 } })).toBe('solid');
    expect(dividerStyle({ display: { style: ['dashed'] } })).toBe('solid');
    expect(dividerStyle({ display: { style: true } })).toBe('solid');
  });

  it('falls back to solid when nothing is configured', () => {
    expect(dividerStyle({})).toBe('solid');
    expect(dividerStyle({ display: null })).toBe('solid');
    expect(dividerStyle({ display: {} })).toBe('solid');
  });
});
