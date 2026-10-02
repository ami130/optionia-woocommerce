import { curveBoxTop, textArcPath } from '@shared/design/arc-geometry';
import type { TextAlign } from '@shared/design/design-geometry.types';
import {
  LINE_HEIGHT,
  fitTextToBox,
  wrapTextLines,
} from '@shared/design/text-geometry';

import type { EditorText } from './text-model';

/**
 * Where the editor draws a text, in canvas pixels (M26d.3).
 *
 * 🔴 **Every number here comes from `@shared/design`, and that is the whole
 * point of the module.** `textArcPath`, `fitTextToBox`, `wrapTextLines` and
 * `curveBoxTop` are the SAME functions the storefront and the print renderer
 * call. Re-deriving any of them here would produce an editor that agrees with
 * the renderer until it quietly does not — and the merchant would find out on a
 * printed object.
 *
 * ⚠️ **The editor is the reference implementation, not a follower.**
 * `arc-geometry.ts` documents its own placement in terms of what the editor
 * does — *"whatever the EDITOR spins is the truth"* — and records the
 * divergences that were measured when the two disagreed (~221px of arc shift,
 * ~123px of rotation origin). So this file reproduces those rules exactly
 * rather than choosing its own.
 */

/** A flat text, wrapped into the lines the renderer will draw. */
export interface FlatPlacement {
  kind: 'flat';
  /** The lines, already wrapped — the editor must not let the browser re-wrap. */
  lines: string[];
  /** Possibly shrunk to fit a fixed box. */
  fontSize: number;
  letterSpacing: number;
  /** Distance between baselines. */
  lineHeight: number;
  /** Where the anchor sits horizontally, in canvas pixels. */
  anchorX: number;
  /** Centre of the first line, in canvas pixels. */
  firstY: number;
  align: TextAlign;
}

/** A curved text, as an arc path plus the box it lands in. */
export interface CurvedPlacement {
  kind: 'curved';
  /** The SVG path the glyphs ride, in ARC-LOCAL coordinates. */
  d: string;
  width: number;
  height: number;
  /** Possibly shrunk, once the run outgrows the ring. */
  fontSize: number;
  letterSpacing: number;
  /** Top-left of the arc's bounding box, in canvas pixels. */
  left: number;
  top: number;
  /** The point the whole thing rotates about, in canvas pixels. */
  originX: number;
  originY: number;
  align: TextAlign;
}

export type TextPlacement = FlatPlacement | CurvedPlacement;

/**
 * First-line centre for a FLAT block.
 *
 * 📌 **A re-expression of `flatBlockFirstY`, not a second rule.** That function
 * takes the box height and line count the renderer computed; this one is handed
 * the same numbers from the editor's own text. The parity test pins them
 * together.
 */
function flatFirstY(
  text: EditorText,
  lineCount: number,
  lineHeight: number,
): number {
  const blockH = lineCount * lineHeight;

  /* 🔴 An auto-growing box (h === 0) has no top or bottom to align to. */
  if (!(text.h > 0) || text.valign === 'middle') {
    return text.cy - blockH / 2 + lineHeight / 2;
  }

  const top = text.cy - text.h / 2;

  if (text.valign === 'top') return top + lineHeight / 2;

  return top + text.h - blockH + lineHeight / 2;
}

/**
 * Resolve a text into what the canvas should draw.
 *
 * 🔴 **The two branches are not interchangeable.** Flat text wraps and shrinks
 * inside its box; curved text rides a ring whose radius is solved from the box,
 * and shrinks only once the run outgrows that ring. `curve === 0` is the
 * boundary, and it is exact — the renderer branches on the same test.
 */
export function placeText(text: EditorText, cw: number, ch: number): TextPlacement {
  if (text.curve !== 0) {
    const arc = textArcPath(
      text.text,
      text.size,
      text.letterSpacing,
      text.curve,
      text.w,
      text.h,
      text.advanceRatio,
    );

    /*
     * 🔴 **Horizontally CENTRED on `cx`, whatever the alignment.** The ring
     * already spans the box, so alignment picks where the run STARTS along it
     * (`arcTextAnchor`) rather than moving the arc. Shifting the box by
     * alignment here would double-apply it.
     */
    const rawLeft = text.cx - arc.width / 2;
    const rawTop = curveBoxTop(text.valign, text.cy, text.h, arc.height);

    /*
     * 🔴 **A fixed box is NOT clamped; a legacy auto-height one IS.**
     * `curveBoxPlace` records why, with the divergence that was measured when
     * this was got wrong: clamping a fixed box moved the arc by up to ~221px
     * against the renderer, and an arc wider than the canvas got pinned to
     * `left = 0`, left-aligning text the editor had centred. Each surface
     * clips at its own edge instead.
     */
    const clamped = !(text.h > 0);
    const left = clamped
      ? Math.max(0, Math.min(rawLeft, cw - arc.width))
      : rawLeft;
    const top = clamped
      ? Math.max(0, Math.min(rawTop, ch - arc.height))
      : rawTop;

    /*
     * 🔴 **A fixed box spins about `(cx, cy)`; a legacy one about its own arc
     * bbox.** `curveRotOrigin` records the ~123px these differ by whenever
     * valign is top or bottom — a real box has a centre of its own, a legacy
     * text's box IS the clamped arc.
     */
    const origin = text.h > 0
      ? { x: text.cx, y: text.cy }
      : { x: left + arc.width / 2, y: top + arc.height / 2 };

    return {
      kind: 'curved',
      d: arc.d,
      width: arc.width,
      height: arc.height,
      fontSize: arc.fontSize,
      letterSpacing: arc.letterSpacing,
      left,
      top,
      originX: origin.x,
      originY: origin.y,
      align: text.align,
    };
  }

  /*
   * ⚠️ **Shrink-to-fit runs ONLY for a fixed box.** An auto-growing one keeps
   * the merchant's size and grows downward; shrinking it would make the size
   * control do nothing once the text got long.
   *
   * 📌 **The `h > 0` test is DEFENSIVE, not behavioural — a mutation proved it
   * rather than a reading.** `fitTextToBox` opens with `!(boxH > 0)` and
   * returns the size untouched, so calling it with an auto-growing box is
   * already a no-op and forcing the call changes nothing any test can see. It
   * is kept because it states the intent at the call site and does not depend
   * on a guard inside another module staying put. Recorded as an equivalent
   * mutant, not claimed as load-bearing.
   */
  const fit =
    text.h > 0
      ? fitTextToBox(
          text.text,
          text.size,
          text.letterSpacing,
          text.w,
          text.h,
          text.advanceRatio,
        )
      : { fontSize: text.size, letterSpacing: text.letterSpacing };

  /*
   * 🔴 **Wrapped HERE, so the browser cannot re-wrap.** The renderer emits one
   * `<tspan>` per line from exactly this call; a canvas that let CSS wrap the
   * same string could break it into a different number of lines, which is the
   * defect `white-space: nowrap` exists to prevent in the original editor.
   */
  const lines = wrapTextLines(
    text.text,
    fit.fontSize,
    fit.letterSpacing,
    text.w,
    text.advanceRatio,
  );
  const lineHeight = fit.fontSize * LINE_HEIGHT;

  /* The anchor, which `text-anchor` then draws from. */
  const anchorX =
    text.align === 'left'
      ? text.cx - text.w / 2
      : text.align === 'right'
        ? text.cx + text.w / 2
        : text.cx;

  return {
    kind: 'flat',
    lines,
    fontSize: fit.fontSize,
    letterSpacing: fit.letterSpacing,
    lineHeight,
    anchorX,
    firstY: flatFirstY(text, lines.length, lineHeight),
    align: text.align,
  };
}
