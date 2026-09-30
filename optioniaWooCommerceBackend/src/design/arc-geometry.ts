/**
 * Curved-text geometry — the ring, its bounding box, and where that box lands.
 *
 * Ported from `optionia-app/app/components/design-lab/designScene.ts` (M26c.1).
 *
 * 📌 **Ported unchanged, on evidence.** Stage 26c.5a rendered the same
 * `<textPath>` through `resvg` and through Chromium and measured them: ink
 * bounding boxes identical to the pixel, a centroid shift of (−0.039, +0.123)px,
 * and zero offset beating all 48 alternatives in a ±3px search. `resvg` resolves
 * `startOffset`, `text-anchor` and the arc parameterisation exactly as a browser
 * does, so none of the formulas below need a compensation layer.
 *
 * 🔴 **Two functions here carry a fixed/legacy split, and neither is a style
 * choice.** `curveBoxPlace` clamps legacy boxes and not fixed ones;
 * `curveRotOrigin` rotates fixed boxes about `(cx, cy)` and legacy ones about
 * the bbox centre. Both encode "whatever the EDITOR spins is the truth", and the
 * source records what collapsing them cost: ~221px of drift in one case and
 * ~123px in the other. They are preserved exactly.
 */

import type { TextAlign, TextVAlign } from './design-geometry.types';
import { estimateTextLength, type SceneText } from './text-geometry';

/**
 * Glyph reach from the baseline, as a fraction of the font size.
 *
 * ⚠️ **Shared constants, not real font metrics, and deliberately so.** The
 * browser surfaces have no metrics available at geometry time, and all four
 * renderers must agree on the geometry exactly — an approximation everyone
 * shares beats a measurement only one surface can take.
 */
const GLYPH_ASCENT = 0.8;
const GLYPH_DESCENT = 0.22;

/**
 * `|curve|` at or above which the arc is treated as a closed circle.
 *
 * ⚠️ Not `100`: the slider yields floating-point values, and a full circle needs
 * two half-arcs because one `A` command cannot close a circle. A run authored at
 * exactly 100 that arrived as 99.97 would silently emit an open arc.
 */
const FULL_CIRCLE_THRESHOLD = 99.9;

/**
 * The analytic arc, for a renderer that cannot use `<textPath>`.
 *
 * 📌 One geometry, two emitters: an SVG surface follows the path `d`, while the
 * order renderer places each glyph itself from these parameters. Both land on
 * the same circle.
 */
export interface ArcParams {
  /** Circle radius (viewBox px). */
  readonly R: number;
  /** Circle centre within the arc's local box (the path `d` coordinates). */
  readonly cx: number;
  readonly cy: number;
  /**
   * Angle (radians) of the PATH START on the circle, in y-down screen coords:
   * `point(φ) = (cx + R·cosφ, cy + R·sinφ)`.
   */
  readonly phi0: number;
  /**
   * Direction the path runs: `+1` = φ increases (clockwise on screen), `−1` =
   * φ decreases. A point at arc-length `s` sits at `φ = phi0 + dir·(s/R)`; its
   * tangent (text direction) is `dir·(−sinφ, cosφ)`.
   */
  readonly dir: 1 | -1;
  /** Total swept angle (radians); path length = `R·theta`. */
  readonly theta: number;
}

/** θ (radians) swept for a curve value; `|curve| = 100` → a FULL circle. */
function curveTheta(curve: number): number {
  return Math.max(0.0001, Math.min(100, Math.abs(curve)) / 100) * 2 * Math.PI;
}

/**
 * How far glyphs reach from the ring, split by side.
 *
 * In SVG `<textPath>` the glyph "up" vector is the path normal, so an ARCH
 * (`curve > 0`, centre below the apex) puts ascenders on the OUTSIDE of the ring
 * and descenders inside; a VALLEY is the mirror. Glyphs therefore occupy the
 * annulus `[R − gIn, R + gOut]` — the one fact every formula below is built on.
 */
function glyphReach(
  fontSize: number,
  curve: number,
): { gOut: number; gIn: number } {
  const up = curve >= 0;
  return {
    gOut: (up ? GLYPH_ASCENT : GLYPH_DESCENT) * fontSize,
    gIn: (up ? GLYPH_DESCENT : GLYPH_ASCENT) * fontSize,
  };
}

/**
 * Ring radius for curved text — pure circle geometry from the CURVE and the BOX
 * only, never from the text.
 *
 * Solves for the largest `R` whose glyph annulus still fits inside
 * `boxW × boxH`, using the exact annular-sector extents `arcGeometryFromR`
 * draws:
 *
 * ```
 *   horizontal  θ ≤ π: 2(R+gOut)·sin(θ/2) ≤ boxW    θ > π: 2(R+gOut) ≤ boxW
 *   vertical    θ ≤ π: (R+gOut) − (R−gIn)·cos(θ/2) ≤ boxH
 *               θ > π: (R+gOut)(1 − cos(θ/2)) ≤ boxH
 * ```
 *
 * 📌 **Both ends of the slider fall out of this one formula**, which is why it
 * needs no special cases. As `curve → 0`, `R → ∞` and the chord → `boxW`: a
 * barely-bent line spanning the full box width, so normal-length text never has
 * to shrink. At `curve = ±100`, `θ = 2π` so `R = min(boxW, boxH)/2 − gOut`: the
 * full circle inscribed in the box's shorter side, glyph overhang included.
 * Continuous everywhere (the branches agree at `θ = π`), so dragging the slider
 * moves the ring smoothly instead of jumping.
 */
export function radiusForBox(
  curve: number,
  boxW: number,
  boxH: number,
  fontSize: number,
): number {
  const theta = curveTheta(curve);
  const half = theta / 2;
  const cosHalf = Math.cos(half);
  const { gOut, gIn } = glyphReach(fontSize, curve);
  const w = boxW > 0 ? boxW : fontSize;
  const h = boxH > 0 ? boxH : w; // legacy designs saved before the fixed height
  const byWidth =
    theta <= Math.PI ? w / (2 * Math.sin(half)) - gOut : w / 2 - gOut;
  const byHeight =
    theta <= Math.PI
      ? (h - gOut - gIn * cosHalf) / (1 - cosHalf)
      : h / (1 - cosHalf) - gOut;
  return Math.max(1, Math.min(byWidth, byHeight));
}

/**
 * Arc geometry from an EXPLICIT radius (`radiusForBox` derives one from the box).
 *
 * Glyphs occupy the annular sector between `rIn = R − gIn` and `rOut = R + gOut`
 * across the swept angle θ, so its EXACT bounding box is
 *
 * ```
 *   width  = 2·(θ ≤ π ? rOut·sin(θ/2) : rOut)
 *   height = rOut − (θ ≤ π ? rIn : rOut)·cos(θ/2)
 * ```
 *
 * Both collapse to the outer diameter at `θ = 2π` and agree at `θ = π`. The
 * circle is then centred so bbox edge = glyph edge: an arch's apex glyph tops sit
 * on `y = 0` and its end descenders on `y = height`; a valley is the mirror.
 */
function arcGeometryFromR(
  R: number,
  fontSize: number,
  curve: number,
): { d: string; width: number; height: number; arc: ArcParams } {
  const theta = curveTheta(curve);
  const half = theta / 2;
  const cosHalf = Math.cos(half);
  const up = curve >= 0;
  const { gOut, gIn } = glyphReach(fontSize, curve);
  const rOut = R + gOut;
  const rIn = Math.max(0, R - gIn);

  const width = 2 * (theta <= Math.PI ? rOut * Math.sin(half) : rOut);
  const height = rOut - (theta <= Math.PI ? rIn : rOut) * cosHalf;
  const cx = width / 2;
  // Arch: the circle sits BELOW the apex, whose glyph tops touch y = 0 (cy = rOut).
  // Valley: mirrored — the lowest glyph edge touches y = height.
  const cy = up ? rOut : height - rOut;

  if (Math.abs(curve) >= FULL_CIRCLE_THRESHOLD) {
    // Full circle — two half-arcs, since one A command cannot close a circle.
    // Start at the BOTTOM so a centred run's midpoint (50% of the path) lands at
    // the TOP and reads rightside-up. φ increasing = clockwise on screen = sweep 1.
    const d = up
      ? `M ${cx} ${cy + R} A ${R} ${R} 0 1 1 ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx} ${cy + R}`
      : `M ${cx} ${cy - R} A ${R} ${R} 0 1 0 ${cx} ${cy + R} A ${R} ${R} 0 1 0 ${cx} ${cy - R}`;
    const arc: ArcParams = up
      ? { R, cx, cy, phi0: Math.PI / 2, dir: 1, theta: 2 * Math.PI }
      : { R, cx, cy, phi0: -Math.PI / 2, dir: -1, theta: 2 * Math.PI };
    return { d, width, height, arc };
  }

  const lx = cx - R * Math.sin(half);
  const rx = cx + R * Math.sin(half);
  const yEnds = up ? cy - R * cosHalf : cy + R * cosHalf;
  // up: path runs left→right over the top, φ from 3π/2−half to 3π/2+half (sweep 1).
  // down: left→right along the bottom, φ from π/2+half down to π/2−half (sweep 0).
  // Both put the path midpoint at the apex / valley centre.
  const arc: ArcParams = up
    ? { R, cx, cy, phi0: 1.5 * Math.PI - half, dir: 1, theta }
    : { R, cx, cy, phi0: 0.5 * Math.PI + half, dir: -1, theta };
  const large = theta > Math.PI ? 1 : 0;
  const sweep = up ? 1 : 0;
  return {
    d: `M ${lx} ${yEnds} A ${R} ${R} 0 ${large} ${sweep} ${rx} ${yEnds}`,
    width,
    height,
    arc,
  };
}

/**
 * The complete curved-text layout: ring, box, and the size the text settles at.
 *
 * 📌 **The ring is measured at the MERCHANT font size, so it stays put as the
 * customer types.** The font then keeps that size until the run outgrows the
 * ring (arc length `R·θ`) and would stretch past the path end; only THEN does it
 * shrink, proportionally — shrink-only, mirroring the flat `fitTextToBox`. `R`
 * is untouched by the shrink; only the glyphs get smaller.
 *
 * ⚠️ **A full circle reserves one extra letter-spacing** so the seam gap matches
 * the rest and the ring closes evenly.
 */
export function textArcPath(
  text: string,
  fontSize: number,
  letterSpacing: number,
  curve: number,
  boxW?: number,
  boxH?: number,
  advanceRatio?: number,
): {
  d: string;
  width: number;
  height: number;
  fontSize: number;
  letterSpacing: number;
  arc: ArcParams;
} {
  const R = radiusForBox(curve, boxW ?? 0, boxH ?? 0, fontSize);
  let fs = fontSize;
  let ls = letterSpacing;
  const arcLen = R * curveTheta(curve);
  const seam =
    Math.abs(curve) >= FULL_CIRCLE_THRESHOLD ? letterSpacing || 0 : 0;
  const runLen = estimateTextLength(text, fs, ls, advanceRatio) + seam;
  if (runLen > arcLen && arcLen > 0) {
    const shrink = arcLen / runLen;
    fs *= shrink;
    ls *= shrink;
  }
  const g = arcGeometryFromR(R, fs, curve);
  return {
    d: g.d,
    width: g.width,
    height: g.height,
    fontSize: fs,
    letterSpacing: ls,
    arc: g.arc,
  };
}

/**
 * Top-left y of a CURVED arc's bounding box, per vertical alignment within a
 * fixed box centred on `cy` with height `boxH`.
 *
 * `boxH ≤ 0` or `middle` centres on `cy`. The mirror of `flatBlockFirstY`, so
 * curved text honours top/middle/bottom the same way flat text does.
 */
export function curveBoxTop(
  valign: TextVAlign,
  cy: number,
  boxH: number,
  arcHeight: number,
): number {
  if (!(boxH > 0) || valign === 'middle') return cy - arcHeight / 2;
  const top = cy - boxH / 2;
  if (valign === 'top') return top;
  return top + boxH - arcHeight; // bottom
}

/**
 * Where a CURVED node's arc bbox lands on the canvas: horizontally CENTRED on
 * `cx` (the ring is already sized to the box, so alignment does not move it —
 * see {@link arcTextAnchor}) and vertically per `valign`.
 *
 * 🔴 **Whether the result is CLAMPED depends on the box, and that is not a style
 * choice — it is what keeps the editor honest.**
 *
 * - **Fixed box (`h > 0`): NO clamp.** The editor draws the arc as a child of
 *   the selection box, which it never clamps, so clamping here moved the arc by
 *   up to **~221px** relative to the Design Lab — and when the arc was wider than
 *   the scene, the clamp pinned `left = 0`, LEFT-aligning text the editor
 *   centred. Each surface simply clips at its own viewBox edge, as the canvas
 *   does.
 * - **Legacy box (`h === 0`, saved before the fixed height): KEEP the clamp.**
 *   The editor's legacy branch clamps identically, so dropping it would move
 *   already-saved designs instead of aligning them.
 */
export function curveBoxPlace(
  tx: Pick<SceneText, 'cx' | 'cy' | 'h' | 'valign'>,
  arcWidth: number,
  arcHeight: number,
  sceneW: number,
  sceneH: number,
): { left: number; top: number } {
  const left = tx.cx - arcWidth / 2;
  const top = curveBoxTop(tx.valign, tx.cy, tx.h, arcHeight);
  if (tx.h > 0) return { left, top };
  return {
    left: Math.max(0, Math.min(left, sceneW - arcWidth)),
    top: Math.max(0, Math.min(top, sceneH - arcHeight)),
  };
}

/**
 * Rotation ORIGIN for a curved node — the same fixed/legacy split as
 * {@link curveBoxPlace}, for the same reason: whatever the EDITOR spins is the
 * truth.
 *
 * - **Fixed box (`h > 0`):** the editor rotates the selection BOX about its own
 *   centre (`translateY(-50%)` + `transform-origin: center center` composes to a
 *   pure rotation about `(cx, cy)`), so the arc must too. The arc bbox centre
 *   sits `(boxH − arcH)/2` away whenever valign is top/bottom — **~123px** in
 *   practice.
 * - **Legacy box (`h === 0`):** there is no box of its own — the editor's box IS
 *   the clamped arc bbox, so the bbox centre is already right, and switching to
 *   `(cx, cy)` would move edge-clamped legacy designs.
 */
export function curveRotOrigin(
  tx: Pick<SceneText, 'cx' | 'cy' | 'h'>,
  left: number,
  top: number,
  arcW: number,
  arcH: number,
): { ox: number; oy: number } {
  return tx.h > 0
    ? { ox: tx.cx, oy: tx.cy }
    : { ox: left + arcW / 2, oy: top + arcH / 2 };
}

/**
 * HORIZONTAL alignment for CURVED text.
 *
 * 📌 **Alignment does not move the arc.** The ring already spans the box (its
 * radius is solved from the box — see {@link radiusForBox}), so alignment picks
 * WHERE THE TEXT STARTS along it, exactly like the anchor on flat text: left =
 * first glyph at the path start, centre = centred on the path, right = last
 * glyph at the path end. The arc's bbox is always centred in the box; only the
 * run slides along the ring. Vertical alignment is the independent one that
 * moves the bbox ({@link curveBoxTop}).
 */
export function arcTextAnchor(align: TextAlign): {
  startOffset: string;
  anchor: 'start' | 'middle' | 'end';
} {
  if (align === 'left') return { startOffset: '0%', anchor: 'start' };
  if (align === 'right') return { startOffset: '100%', anchor: 'end' };
  return { startOffset: '50%', anchor: 'middle' };
}
