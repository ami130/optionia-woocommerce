/**
 * Flat-text geometry — measurement, wrapping, shrink-to-fit, and the resolution
 * of a stored `TextDesign` into viewBox pixels.
 *
 * Ported from `optionia-app/app/components/design-lab/designScene.ts` (M26c.5b).
 * The port is deliberately faithful: these functions decide where a customer's
 * name lands on a physical object, and the editor, the storefront preview and
 * this renderer must agree to the pixel or the merchant ships a product that
 * does not match the proof. One divergence noted and fixed below — `LINE_HEIGHT`.
 */

import type { TextAlign, TextDesign, TextVAlign } from './design-geometry.types';

/**
 * Line height as a multiple of the font size.
 *
 * 🔴 **This constant is the fix that 26c.5b exists for.** In `optionia-app` the
 * value `1.25` is written out five separate times across four files — in
 * `fitTextToBox` (as a local `LINE_H` carrying the comment *"must match
 * serializeTextNode / the editor line height"*), in `serializeTextNode`, in
 * `DesignSvg.tsx`, and twice in `TextDesignLabModal.tsx`. Nothing enforces the
 * agreement that comment asks for.
 *
 * ⚠️ **The failure is silent and it is a reprint.** `fitTextToBox` uses the
 * value to decide how many lines fit — and therefore what font size to shrink
 * to — while the renderer uses it to space the lines it draws. If the two ever
 * differ, text is measured at one line height and drawn at another: it fits in
 * the editor and overflows the print file, or shrinks when it did not need to.
 * Naming it once makes the drift impossible rather than merely discouraged.
 */
export const LINE_HEIGHT = 1.25;

/**
 * Average glyph advance as a fraction of the font size — the FALLBACK used when
 * no measured `advanceRatio` is available (server-built scenes, legacy designs).
 *
 * ⚠️ Deliberately generous, so estimated text sits on an arc without clipping.
 * Narrow glyphs (i, j, s) fall far below it, which is why a full circle sized
 * from the estimate leaves a visible gap — the editor measures a real ratio and
 * persists it instead.
 */
export const CHAR_ADVANCE = 0.62;

/** The shrink floor of {@link fitTextToBox}, as a fraction of the maximum size. */
export const MIN_FONT_RATIO = 1 / 25;

/** Iterations of the binary search in {@link fitTextToBox}. */
const FIT_ITERATIONS = 24;

/** A `TextDesign` resolved from canvas fractions into viewBox pixels. */
export interface SceneText {
  /** The content to draw — the customer's typed value, or the merchant sample. */
  readonly text: string;
  readonly font: string;
  /** px in viewBox. */
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly align: TextAlign;
  /** Vertical placement of the text inside the box. */
  readonly valign: TextVAlign;
  readonly color: string;
  /** Box centre x in viewBox px. */
  readonly cx: number;
  /** Box centre y in viewBox px (vertical middle). */
  readonly cy: number;
  /** Box width in viewBox px (anchor + curve span). */
  readonly w: number;
  /** Box height in viewBox px. `0` = auto; `> 0` = fixed box, font shrinks to fit. */
  readonly h: number;
  /** Degrees, about (cx, cy). */
  readonly rot: number;
  /** -100..100; 0 = flat; ±100 = full circle. */
  readonly curve: number;
  /** px in viewBox. */
  readonly letterSpacing: number;
  /** Measured average glyph advance ÷ fontSize. `0` = use {@link CHAR_ADVANCE}. */
  readonly advanceRatio: number;
}

/** SVG `text-anchor` + `startOffset` for an alignment, shared by every renderer. */
export interface TextAnchor {
  readonly anchor: 'start' | 'middle' | 'end';
  readonly offset: string;
  readonly dx: number;
}

export function textAnchorFor(align: TextAlign): TextAnchor {
  if (align === 'left') return { anchor: 'start', offset: '0%', dx: -0.5 };
  if (align === 'right') return { anchor: 'end', offset: '100%', dx: 0.5 };
  return { anchor: 'middle', offset: '50%', dx: 0 };
}

/**
 * Resolve a stored `TextDesign` (canvas fractions) into a viewBox-pixel
 * `SceneText`.
 *
 * ⚠️ **The `|| 0.5` on `wPct` is not the same as the `?? 0.5` on `xPct`**, and
 * the difference is load-bearing in the source. A stored `wPct` of `0` means "no
 * width was recorded", and `||` maps it to the half-canvas default; `xPct` of
 * `0` is a legitimate left edge and must survive, so it uses `??`. Ported as
 * written.
 */
/**
 * A stored number, or the fallback when it is not one.
 *
 * 🔴 **`Infinity` and `NaN` reach the emitted SVG otherwise**, measured: a
 * stored `rot: Infinity` produces `rotate(Infinity …)`. `resvg` tolerates it —
 * it renders, dropping the rotation — so the result is a SILENTLY WRONG print
 * file rather than a failure anyone sees.
 *
 * ⚠️ **The editor's `clampText` cannot cover this.** It guards what a merchant
 * types; this guards what STORAGE returns, and the API stores a design body
 * unvalidated by design. Every surface reads through here, so one guard serves
 * all of them.
 *
 * 📌 **`?? ` is not enough and neither is `||`.** Both pass `Infinity`
 * through — it is neither null nor falsy.
 */
function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveSceneText(
  design: TextDesign,
  vbW: number,
  vbH: number,
  value?: string,
): SceneText {
  const w = (finite(design.pos.wPct, 0) || 0.5) * vbW;
  return {
    text: (value ?? design.text ?? '').toString(),
    font: design.font,
    fontSize: (finite(design.sizePct, 0) || 0) * vbH,
    bold: !!design.bold,
    italic: !!design.italic,
    align: design.align ?? 'center',
    valign: design.valign ?? 'middle',
    color: design.color || '#000000',
    cx: finite(design.pos.xPct, 0.5) * vbW,
    cy: finite(design.pos.yPct, 0.5) * vbH,
    w,
    h: finite(design.pos.hPct, 0) * vbH,
    rot: finite(design.rot, 0),
    curve: Math.max(-100, Math.min(100, finite(design.curve, 0))),
    letterSpacing: finite(design.letterSpacing, 0) * vbH,
    advanceRatio:
      design.advanceRatio && design.advanceRatio > 0 ? design.advanceRatio : 0,
  };
}

/**
 * Estimated on-screen length of a text run at a given size + letter spacing.
 *
 * A measured `advanceRatio` (average glyph advance ÷ font size) overrides
 * {@link CHAR_ADVANCE} when present, so the run length matches the real rendered
 * glyphs. The glyph count cancels — `n·fontSize·(measuredWidth/(fontSize·n))` is
 * `measuredWidth` — so a ratio is exact regardless of the size it was taken at.
 *
 * ⚠️ **Counts code points, not UTF-16 units.** `[...text]` rather than
 * `text.length`, so an emoji or an astral-plane character counts once. With
 * `.length` every such character would be measured as two glyphs and the text
 * would shrink when it did not need to.
 */
export function estimateTextLength(
  text: string,
  fontSize: number,
  letterSpacing: number,
  advanceRatio?: number,
): number {
  const n = Math.max(1, [...(text || ' ')].length);
  const adv = advanceRatio && advanceRatio > 0 ? advanceRatio : CHAR_ADVANCE;
  return n * fontSize * adv + Math.max(0, n - 1) * (letterSpacing || 0);
}

/**
 * Greedily wrap `text` into lines that each fit within `maxWidth` (viewBox px).
 *
 * Character-level — it breaks anywhere a line fills, which is how a long name
 * wraps mid-word — and honours explicit `\n`. This is the ONE wrap used by the
 * editor and every renderer, so break points are identical everywhere.
 *
 * ⚠️ **Iterates code points.** `for...of` over a string, so a surrogate pair is
 * never split across two lines — which would render as two replacement glyphs.
 */
export function wrapTextLines(
  text: string,
  fontSize: number,
  letterSpacing: number,
  maxWidth: number,
  advanceRatio?: number,
): string[] {
  const out: string[] = [];
  const limit = Math.max(1, maxWidth);
  for (const segment of (text ?? '').split('\n')) {
    if (segment === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of segment) {
      if (
        line &&
        estimateTextLength(line + ch, fontSize, letterSpacing, advanceRatio) > limit
      ) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Largest font size ≤ `maxFontSize` whose wrapped lines fit inside a
 * `boxW`×`boxH` box (viewBox px).
 *
 * SHRINK-ONLY — never returns more than `maxFontSize`; letter spacing scales
 * down with the font so the look stays proportional. With no fixed height
 * (`boxH ≤ 0`) the maximum size is returned unchanged (legacy auto-height).
 * Shared by the editor, the storefront and the order renderer, so the customer's
 * text shrinks identically wherever it lands.
 *
 * 📌 **The shrink floor is RELATIVE (`maxFontSize / 25`), not an absolute pixel
 * count, and the source records why.** Every other quantity here is a ratio
 * (`boxH/fs`, `boxW/fs`); an absolute floor was the one scale-dependent term, and
 * it was evaluated in EDITOR px in the lab (8 px on a 460-tall canvas) but in
 * NATURAL px everywhere else — so the two surfaces stopped shrinking at different
 * sizes and produced different line counts. A relative floor is identical in both
 * spaces. Below it text may overflow; the caller clips.
 */
export function fitTextToBox(
  text: string,
  maxFontSize: number,
  letterSpacing: number,
  boxW: number,
  boxH: number,
  advanceRatio?: number,
  /** Shrink floor as a FRACTION of `maxFontSize` (scale-free — see above). */
  minFontRatio = MIN_FONT_RATIO,
): { fontSize: number; letterSpacing: number } {
  if (!(boxH > 0) || !(boxW > 0) || maxFontSize <= 0) {
    return { fontSize: maxFontSize, letterSpacing };
  }
  const lsAt = (fs: number) => letterSpacing * (fs / maxFontSize);
  const fits = (fs: number): boolean =>
    wrapTextLines(text, fs, lsAt(fs), boxW, advanceRatio).length * fs * LINE_HEIGHT <=
    boxH;

  if (fits(maxFontSize)) return { fontSize: maxFontSize, letterSpacing };

  const lo0 = Math.min(maxFontSize * minFontRatio, maxFontSize);
  if (!fits(lo0)) return { fontSize: lo0, letterSpacing: lsAt(lo0) };

  // Binary search the largest fitting size (`fits` is monotonic: bigger fs → taller).
  let lo = lo0;
  let hi = maxFontSize;
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { fontSize: lo, letterSpacing: lsAt(lo) };
}

/**
 * First-line baseline y for a wrapped FLAT block, per vertical alignment within
 * a fixed box centred on `cy` with height `boxH`.
 *
 * Lines use `dominant-baseline="central"` (a line's vertical centre sits at its
 * y), so the block's visual top is `firstY − lineH/2`. `boxH ≤ 0` (legacy) or
 * `middle` centres on `cy`. Shared by every renderer so vertical placement is
 * identical everywhere.
 */
export function flatBlockFirstY(
  valign: TextVAlign,
  cy: number,
  boxH: number,
  lineCount: number,
  lineH: number,
): number {
  const centered = cy - ((lineCount - 1) * lineH) / 2;
  if (!(boxH > 0) || valign === 'middle') return centered;
  const top = cy - boxH / 2;
  if (valign === 'top') return top + lineH / 2;
  return top + boxH - lineCount * lineH + lineH / 2; // bottom
}
