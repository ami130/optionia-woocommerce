import { clampInside } from '@shared/design/layer-geometry';

import type { EditorLayer } from './layer.types';

/**
 * Pointer-drag maths, extracted from the canvas component.
 *
 * 🔴 **This is arithmetic that happened to live in a DOM event handler.** The
 * original `onMove` reads only `clientX` and `clientY` — no element rects, no
 * styles — and everything after that is trigonometry. Extracting it is what
 * makes the hardest part of the editor testable in a project with no JSX runner.
 *
 * ⚠️ **Every function here is pure**: a drag descriptor and a delta in, a new
 * rect out. Nothing mutates a layer and nothing touches the store, so the
 * component stays responsible for applying the result and for deciding when a
 * gesture ends.
 */

/**
 * The smallest a layer may be resized to.
 *
 * ⚠️ **Measured in the LAYER's own frame, not on screen.** A rotated layer at
 * this size has a screen-space bounding box larger than 24px — correct, because
 * the bound exists so the merchant can still grab a handle, and the handles sit
 * on the layer's own edges.
 *
 * 🔴 **Recorded because the obvious "fix" is wrong.** Rewriting this to bound
 * the screen box would change the minimum size at every angle, so a layer would
 * stop shrinking at 24px when square and at ~34px when turned 45°.
 */
export const MIN_LAYER_SIZE = 24;

/** Shift-drag snaps rotation to this many degrees. */
export const ROTATION_SNAP_DEGREES = 15;

/** A layer's box: centre, size, rotation. */
export interface DragRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Which axes a drag may change, and whether the result is clamped on-canvas. */
export interface MoveAxes {
  readonly x: boolean;
  readonly y: boolean;
  readonly clamp: boolean;
}

/**
 * Which axes a style permits dragging along.
 *
 * 🔴 **A style that pins an axis must not be draggable along it.** `cover` fills
 * the canvas, so moving it does nothing visible and would only desynchronise the
 * stored centre from what renders; `fullw` owns the horizontal, so only the
 * vertical is free.
 *
 * ⚠️ **`fit` is CONDITIONAL.** It fills one axis exactly, so the other is
 * draggable only while the layer is smaller than the canvas — which is the same
 * band `clampInside` operates in, and the case whose test was degenerate until
 * a mutation exposed it.
 */
export function moveAxes(layer: EditorLayer, cw: number, ch: number): MoveAxes {
  if (layer.style === 'cover') return { x: false, y: false, clamp: false };
  if (layer.style === 'free') return { x: true, y: true, clamp: false };
  if (layer.style === 'fullw') return { x: false, y: true, clamp: true };
  if (layer.style === 'fullh') return { x: true, y: false, clamp: true };

  if (layer.style === 'fit') {
    return { x: layer.w < cw - 0.5, y: layer.h < ch - 0.5, clamp: true };
  }

  return { x: true, y: true, clamp: false };
}

/** How far off-canvas a free layer may be dragged before it is caught. */
const OFF_CANVAS_MARGIN = 20;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Where a dragged layer lands.
 *
 * 📌 **Two clamping regimes, and the difference is deliberate.** A clamped style
 * ( `fit`, `fullw`, `fullh` ) is held fully on-canvas by `clampInside`, because
 * its geometry is defined relative to the canvas. A `free` layer may hang off
 * the edge — a merchant positioning artwork that bleeds past the product edge is
 * doing something ordinary — but never so far that no part of it is grabbable.
 */
export function moveTo(
  start: DragRect,
  delta: { dx: number; dy: number },
  axes: MoveAxes,
  size: { w: number; h: number },
  canvas: { cw: number; ch: number },
): { cx: number; cy: number } {
  const ncx = axes.x ? start.cx + delta.dx : start.cx;
  const ncy = axes.y ? start.cy + delta.dy : start.cy;

  if (axes.clamp) {
    return {
      cx: clampInside(ncx, size.w / 2, canvas.cw),
      cy: clampInside(ncy, size.h / 2, canvas.ch),
    };
  }

  return {
    cx: clamp(ncx, -size.w / 2 + OFF_CANVAS_MARGIN, canvas.cw + size.w / 2 - OFF_CANVAS_MARGIN),
    cy: clamp(ncy, -size.h / 2 + OFF_CANVAS_MARGIN, canvas.ch + size.h / 2 - OFF_CANVAS_MARGIN),
  };
}

/** Which edges a handle pulls: `-1`, `0` or `1` per axis. */
export function handleDirection(dir: string): { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } {
  const hx = dir.includes('w') ? -1 : dir.includes('e') ? 1 : 0;
  const hy = dir.includes('n') ? -1 : dir.includes('s') ? 1 : 0;

  return { hx, hy };
}

/**
 * Where a resized layer lands, dragging handle `dir` by a screen delta.
 *
 * 🔴 **Four behaviours are coupled here, and three are invisible at rot = 0.**
 *
 * 1. **The delta is rotated into the LAYER's frame.** Dragging the east handle
 *    of a layer turned 90° must widen it along its own axis, not the screen's.
 * 2. **The aspect is locked for everything except a `square` frame.** A plain
 *    layer must never stretch its image; a `square` frame resizes freely on each
 *    axis because the image re-covers it.
 * 3. **An edge handle moves ONE axis.** A corner moves both.
 * 4. **The centre is compensated so the OPPOSITE corner stays still** — and the
 *    compensation is itself rotated back into screen space. Without it, a layer
 *    drifts while being resized, which reads as jitter rather than a maths bug.
 *
 * ⚠️ **At `rot = 0` every rotation term vanishes** — `cos` is 1 and `sin` is 0 —
 * so a test at zero rotation passes with the trigonometry deleted. The suite
 * tests non-zero angles for exactly that reason.
 */
export function resizeFrom(
  start: DragRect,
  delta: { dx: number; dy: number },
  dir: string,
  rotationDeg: number,
  shape: EditorLayer['shape'],
): DragRect {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);

  /* The screen delta, expressed along the layer's own axes. */
  const ldx = delta.dx * cos + delta.dy * sin;
  const ldy = -delta.dx * sin + delta.dy * cos;

  const { hx, hy } = handleDirection(dir);

  let nw = Math.max(MIN_LAYER_SIZE, start.w + hx * ldx);
  let nh = Math.max(MIN_LAYER_SIZE, start.h + hy * ldy);

  if (shape === 'square') {
    /* Free on each axis: an edge stretches one dimension, a corner both. */
    if (hx === 0) nw = start.w;
    if (hy === 0) nh = start.h;
  } else {
    /*
     * Aspect-locked. A plain layer keeps the image's ratio; every other frame is
     * a square, so `start.w / start.h` is 1 and the lock keeps it square.
     */
    const aspect = start.w / start.h;

    if (hx === 0) {
      nh = Math.max(MIN_LAYER_SIZE, nh);
      nw = nh * aspect;
    } else {
      nw = Math.max(MIN_LAYER_SIZE, nw);
      nh = nw / aspect;
    }
  }

  /* Hold the opposite corner: shift the centre by half the growth, rotated back. */
  const slx = (hx * (nw - start.w)) / 2;
  const sly = (hy * (nh - start.h)) / 2;

  return {
    cx: start.cx + (slx * cos - sly * sin),
    cy: start.cy + (slx * sin + sly * cos),
    w: nw,
    h: nh,
  };
}

/**
 * The angle a rotation drag produces, in degrees.
 *
 * 📌 **Measured from the layer's centre to the pointer**, offset by wherever the
 * drag began — so the handle stays under the cursor rather than jumping to it.
 *
 * ⚠️ **Normalised into 0..360.** A bare modulo leaves negatives, and a stored
 * `-90` renders identically while comparing unequal to `270` — which is how a
 * "did the rotation change?" check starts lying.
 */
export function rotateTo(
  pointer: { x: number; y: number },
  centre: { x: number; y: number },
  startAngleRad: number,
  startRotationDeg: number,
  snap = false,
): number {
  const angle = Math.atan2(pointer.y - centre.y, pointer.x - centre.x);
  let deg = startRotationDeg + ((angle - startAngleRad) * 180) / Math.PI;

  deg = ((deg % 360) + 360) % 360;

  if (snap) {
    deg = Math.round(deg / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES;
  }

  return deg;
}
