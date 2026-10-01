import { moveAxes } from './drag-geometry';
import type { EditorLayer } from './layer.types';

/**
 * The geometry of the selection overlay — the dashed box, and which handles it
 * carries.
 *
 * 🔴 **Extracted for the same reason as `drag-dispatch`.** In the source this
 * lives inline in the `SelectionBox` component, where a project with no JSX test
 * runner cannot reach it. The maths is a pure function of the layer; only the
 * `<div>`s around it need a DOM.
 *
 * ⚠️ **This is the READ side of the handles the dispatcher acts on.** If the box
 * shows a handle the dispatcher refuses, or hides one it would accept, the two
 * disagree silently — a handle that does nothing, or a drag with nothing to grab.
 * The shared rule is `showHandles`: both sides answer it from `locked` and
 * `style`.
 */

/** The dashed box in canvas pixels, before rotation is applied. */
export interface SelectionRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

/** Every handle an unrotated, freely-sized layer offers. */
export const ALL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

/**
 * The handles a ratio-locked frame offers.
 *
 * 📌 **Corners only, and the reason is in the resize maths.** An edge handle
 * drives one axis; a frame whose shape must stay square has no one-axis resize
 * to offer, so the edge handles would silently behave as corners.
 */
export const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'] as const;

/** A layer's box on the canvas, centre-and-size resolved to corner-and-size. */
export function selectionRect(layer: EditorLayer): SelectionRect {
  return {
    left: layer.cx - layer.w / 2,
    top: layer.cy - layer.h / 2,
    w: layer.w,
    h: layer.h,
  };
}

/**
 * The box as drawn, clipped to the canvas for non-free styles.
 *
 * 🔴 **Why only when `rot === 0`.** A fitted layer can extend past the canvas
 * edge — `cover` always does — and drawing the dashed box out there would mark
 * a region the merchant cannot see. Clipping fixes that, but only for an
 * axis-aligned box: once rotated, the drawn rectangle is rotated about its own
 * centre, so trimming its sides moves that centre and the box slides away from
 * the layer it marks. The source makes the same choice, and leaving it rotated
 * is the lesser wrong.
 *
 * ⚠️ **`free` is excluded deliberately.** A freely placed layer is where the
 * merchant put it, including half off the canvas, and clipping its box would
 * hide the handles needed to drag it back.
 */
export function drawnSelectionRect(
  layer: EditorLayer,
  cw: number,
  ch: number,
): SelectionRect {
  const rect = selectionRect(layer);

  if (layer.style === 'free' || layer.rot !== 0) {
    return rect;
  }

  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.left + rect.w, cw);
  const bottom = Math.min(rect.top + rect.h, ch);

  return {
    left,
    top,
    /* A box entirely off-canvas clamps to zero rather than going negative. */
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
}

/**
 * Whether the layer offers resize and rotate handles at all.
 *
 * 📌 **Locked is the merchant's choice; non-free is the style's.** A `fit` or
 * `cover` layer is sized by its style, so a resize handle would be overwritten
 * on the next re-fit.
 */
export function showsHandles(layer: EditorLayer): boolean {
  return !layer.locked && layer.style === 'free';
}

/**
 * Which handles to draw.
 *
 * ⚠️ **`square` frames resize freely, every other shape is ratio-locked.** That
 * is the same split {@link applyStyleGeometry} has, and `none` (a plain layer)
 * sits on the free side with `square`.
 */
export function handlesFor(layer: EditorLayer): readonly string[] {
  const ratioLocked = layer.shape !== 'none' && layer.shape !== 'square';

  return ratioLocked ? CORNER_HANDLES : ALL_HANDLES;
}

/**
 * The cursor a layer shows, which is the merchant's only clue that it can be
 * dragged — and along which axes.
 *
 * 🔴 **This is how `pinned` becomes visible.** `dragIntentFor` returns
 * `select-only` with reason `pinned` for a layer whose style allows no movement,
 * and `drag-dispatch` keeps that reason distinct from `locked` precisely so the
 * UI can explain it. Without a cursor the explanation is never given: the layer
 * looks draggable, silently refuses, and reads as a broken app rather than a
 * constraint.
 *
 * 📌 **Four outcomes, from the same `moveAxes` the drag uses.** Both axes is a
 * move; one axis is the resize cursor for that axis, because a one-axis drag is
 * exactly what those arrows mean; neither is the default arrow.
 *
 * ⚠️ **A locked layer reports `default` without consulting its axes.** A lock is
 * the merchant's own choice and outranks the style — showing `move` on a locked
 * layer would promise a drag the dispatcher refuses.
 */
export function layerCursor(layer: EditorLayer, cw: number, ch: number): string {
  if (layer.locked) {
    return 'default';
  }

  const axes = moveAxes(layer, cw, ch);

  if (axes.x && axes.y) return 'move';
  if (axes.x) return 'ew-resize';
  if (axes.y) return 'ns-resize';

  return 'default';
}
