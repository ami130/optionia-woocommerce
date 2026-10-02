import { TEXT_FONTS, type TextFont } from '@shared/design/design-geometry.types';

/**
 * The CSS2 axis spec each curated family actually publishes.
 *
 * 🔴 **Asking for an axis a family does not have does NOT fail loudly.**
 * Measured against the live API on 2026-10-02: Oswald requested with `ital`
 * returns HTTP 200 and simply omits every italic face; Pacifico requested with
 * `wght@400;700` returns 200 with only the 400. So a wrong entry here produces
 * text that silently renders in a synthesised or fallback face — and the
 * merchant's measured `advanceRatio` is then taken from the wrong glyphs.
 *
 * ⚠️ **A misspelt FAMILY is the fatal one — HTTP 400 for the whole
 * stylesheet**, which loads none of the eight. That is why the gate checks this
 * map against `TEXT_FONTS` rather than trusting it to be edited in step.
 *
 * 📌 **The inherited comment said an unavailable axis 400s.** It does not, as
 * of this measurement; the failure is silent instead. Recorded because the
 * difference changes what a reader should watch for.
 */
export const TEXT_FONT_AXES: Record<TextFont, string> = {
  Roboto: ':ital,wght@0,400;0,700;1,400;1,700',
  'Open Sans': ':ital,wght@0,400;0,700;1,400;1,700',
  Montserrat: ':ital,wght@0,400;0,700;1,400;1,700',
  Lato: ':ital,wght@0,400;0,700;1,400;1,700',
  /* No italic face is published. */
  Oswald: ':wght@400;700',
  'Playfair Display': ':ital,wght@0,400;0,700;1,400;1,700',
  /* No italic face is published. */
  'Dancing Script': ':wght@400;700',
  /* Regular 400 only — no bold, no italic. Both are synthesised by the browser. */
  Pacifico: '',
};

/**
 * The stylesheet URL for every curated family, in one request.
 *
 * 📌 **One combined request, not eight.** It is how the original editor and the
 * storefront both load them, so all three surfaces resolve the same faces.
 */
export function googleFontsHref(): string {
  const families = TEXT_FONTS.map(
    (f) => `family=${f.replaceAll(' ', '+')}${TEXT_FONT_AXES[f]}`,
  ).join('&');

  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** The CSS `font` shorthand for a face, as `CanvasRenderingContext2D` wants it. */
export function fontShorthand(
  font: string,
  bold: boolean,
  italic: boolean,
  sizePx: number,
): string {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${sizePx}px "${font}"`;
}

/**
 * The size glyph advances are measured at.
 *
 * 📌 **Any size would do, because the ratio divides it out** — the stored
 * `advanceRatio` is scale-invariant. A large one keeps the measurement away
 * from hinting and rounding at small sizes.
 */
export const MEASURE_PX = 100;

/**
 * The average glyph advance for a run, as a fraction of the font size.
 *
 * 🔴 **This is what makes a full circle actually close.** The generic estimate
 * (`CHAR_ADVANCE`, 0.62) overshoots narrow text — i, j, s — so a ring sized by
 * it leaves a visible gap at the seam. Measured in the browser and persisted,
 * so every surface sizes the arc to the real glyphs.
 *
 * ⚠️ **Returns null rather than a guess** when there is no DOM, no 2D context,
 * or nothing measurable. The geometry falls back to `CHAR_ADVANCE`, which is
 * the documented behaviour for an absent ratio.
 */
export function measureAdvanceRatio(
  text: string,
  font: string,
  bold: boolean,
  italic: boolean,
): number | null {
  if (typeof document === 'undefined') return null;

  /*
   * ⚠️ **Code points, not UTF-16 units** — `estimateTextLength` counts the same
   * way. With `.length` an emoji would count twice and the ratio would halve.
   */
  const count = Math.max(1, [...(text || ' ')].length);
  const ctx = document.createElement('canvas').getContext('2d');

  if (!ctx) return null;

  ctx.font = fontShorthand(font, bold, italic, MEASURE_PX);

  const width = ctx.measureText(text || ' ').width;

  if (!(width > 0)) return null;

  return width / (MEASURE_PX * count);
}

/**
 * How far a measured ratio must move before it is worth storing.
 *
 * 🔴 **Without a threshold the measurement loops.** Storing a ratio re-renders,
 * which re-measures, which stores again — and floating-point noise means the
 * value never settles exactly.
 */
export const ADVANCE_RATIO_EPSILON = 0.003;

/** Whether a freshly measured ratio is a meaningful change from the stored one. */
export function advanceRatioChanged(
  measured: number | null,
  stored: number | undefined,
): boolean {
  if (measured === null || !(measured > 0)) return false;

  return Math.abs(measured - (stored ?? 0)) > ADVANCE_RATIO_EPSILON;
}
