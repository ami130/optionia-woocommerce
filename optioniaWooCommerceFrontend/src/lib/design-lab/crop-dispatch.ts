import type { EditorLayer } from './layer.types';
import { type CroppableLayer, cropAxes } from './crop-geometry';
import type { MoveAxes } from './drag-geometry';

/**
 * What a mousedown does while crop mode is open (M26d.2).
 *
 * 🔴 **A second dispatcher, not an extension of the first.** In crop mode the
 * same pixels mean different things: a drag on the image pans it inside its
 * frame rather than moving the frame on the canvas, and the grips resize the
 * image rather than the layer. The outer dispatcher is unreachable while this
 * one is open, which is why the two are separate functions rather than one with
 * a mode flag — a flag would make every outer branch read "unless cropping".
 *
 * ⚠️ **Anything outside the cropped layer LEAVES crop mode**, and does not also
 * act. A click on another layer while adjusting a photo is far more likely to be
 * "I am finished here" than "select that, instantly"; the source makes the same
 * choice, and the second click selects.
 */

/** What the pointer landed on, once `closest()` has resolved it. */
export type CropHitKind =
  | 'crop-rotate-handle'
  | 'crop-resize-handle'
  | 'cropped-layer'
  | 'outside';

/** A crop gesture to begin, or the reason there is none. */
export type CropIntent =
  | { kind: 'crop-rotate'; startRotationDeg: number }
  | { kind: 'crop-resize'; dir: string }
  | { kind: 'crop-move'; axes: MoveAxes }
  | { kind: 'exit-crop' }
  /** A pinned image: the gesture is refused, but crop mode stays open. */
  | { kind: 'none' };

/**
 * Decide what a mousedown starts while cropping.
 *
 * 📌 **A pinned image answers `none`, not `exit-crop`.** An image whose style
 * fills the frame cannot pan, and a merchant pressing on it has not asked to
 * leave — ending crop mode there would make a `cover` image impossible to
 * rotate or resize, since both grips live inside the same box.
 */
export function cropIntentFor(
  hit: CropHitKind,
  layer: (EditorLayer & CroppableLayer) | null,
  handleDir?: string,
): CropIntent {
  if (hit === 'outside') return { kind: 'exit-crop' };

  /* A hit that resolves to no layer is a stale id; leaving is the safe answer. */
  if (!layer) return { kind: 'exit-crop' };

  if (hit === 'crop-rotate-handle') {
    return { kind: 'crop-rotate', startRotationDeg: layer.crop?.rot ?? 0 };
  }

  if (hit === 'crop-resize-handle') {
    /*
     * ⚠️ A handle with no direction is a malformed element, not a resize from
     * nowhere — the same refusal the outer dispatcher makes.
     */
    if (!handleDir) return { kind: 'none' };

    return { kind: 'crop-resize', dir: handleDir };
  }

  const axes = cropAxes(layer);

  if (!axes.x && !axes.y) return { kind: 'none' };

  return { kind: 'crop-move', axes };
}

/**
 * Whether crop mode may be entered for a layer at all.
 *
 * 🔴 **The same three refusals `enterCrop` applies**, extracted so the UI can
 * grey the control rather than offering one that silently does nothing — the
 * lesson `layerCursor` already carries for dragging.
 */
export function canEnterCrop(layer: EditorLayer | null): boolean {
  return (
    layer !== null &&
    layer.kind !== 'background' &&
    layer.shape !== 'none' &&
    !layer.locked
  );
}
