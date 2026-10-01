import type { EditorLayer } from './layer.types';
import { type MoveAxes, moveAxes } from './drag-geometry';

/**
 * What a mousedown on the canvas should start.
 *
 * 🔴 **The DECISION, separated from the DOM that informs it.** The original
 * dispatcher interleaves three things: resolving what was clicked via
 * `closest()`, deciding what that implies, and recording the drag. Only the
 * first is DOM-bound — so the middle one lives here, where it can be tested in a
 * project with no JSX runner.
 *
 * ⚠️ **Three guards live in this decision and nowhere else.** A locked layer is
 * selected but not dragged; a layer whose style pins both axes cannot be moved
 * at all; clicking empty canvas deselects. Left in the component they would be
 * unverifiable.
 */

/** What the pointer landed on, once `closest()` has resolved it. */
export type HitKind = 'rotate-handle' | 'resize-handle' | 'layer' | 'empty';

/** A drag the canvas should begin, or the reason it should not. */
export type DragIntent =
  | {
      kind: 'rotate';
      layerId: string;
      /** The layer's rotation when the gesture began. */
      startRotationDeg: number;
    }
  | {
      kind: 'resize';
      layerId: string;
      /** Which handle: `nw`, `se`, `e`… */
      dir: string;
      start: { cx: number; cy: number; w: number; h: number };
    }
  | {
      kind: 'move';
      layerId: string;
      start: { cx: number; cy: number; w: number; h: number };
      axes: MoveAxes;
    }
  | {
      kind: 'select-only';
      layerId: string;
      /**
       * Why no drag began.
       *
       * ⚠️ **`locked` and `pinned` are different refusals.** A locked layer is
       * the merchant's own choice and reversible from the sidebar; a pinned one
       * is a consequence of its fit mode, and unpinning means changing the
       * style. Collapsing them to one reason would make the UI unable to explain
       * either.
       */
      reason: 'locked' | 'pinned';
    }
  | { kind: 'deselect' }
  | { kind: 'none' };

/**
 * Decide what a mousedown starts.
 *
 * 🔴 **Selection happens even when dragging does not**, and the order is
 * load-bearing: the original selects the layer, notifies, and only then checks
 * whether it may be moved. A locked layer is still selectable — the merchant
 * needs to see its properties and to find the control that unlocks it.
 *
 * 📌 A rotate or resize handle only exists on the SELECTED layer's box, so those
 * hits do not re-select; reaching one means the layer is already selected.
 */
export function dragIntentFor(
  hit: HitKind,
  layer: EditorLayer | null,
  canvas: { cw: number; ch: number },
  handleDir?: string,
): DragIntent {
  if (hit === 'empty') {
    return { kind: 'deselect' };
  }

  /* A hit on a layer or handle that resolves to no layer is a stale id. */
  if (!layer) {
    return { kind: 'none' };
  }

  if (hit === 'rotate-handle') {
    return { kind: 'rotate', layerId: layer.id, startRotationDeg: layer.rot };
  }

  if (hit === 'resize-handle') {
    /*
     * ⚠️ A handle with no direction is a malformed element, not a resize from
     * nowhere — refusing is safer than guessing a corner.
     */
    if (!handleDir) {
      return { kind: 'none' };
    }

    return {
      kind: 'resize',
      layerId: layer.id,
      dir: handleDir,
      start: { cx: layer.cx, cy: layer.cy, w: layer.w, h: layer.h },
    };
  }

  /* hit === 'layer': select first, then decide about dragging. */
  if (layer.locked) {
    return { kind: 'select-only', layerId: layer.id, reason: 'locked' };
  }

  const axes = moveAxes(layer, canvas.cw, canvas.ch);

  if (!axes.x && !axes.y) {
    return { kind: 'select-only', layerId: layer.id, reason: 'pinned' };
  }

  return {
    kind: 'move',
    layerId: layer.id,
    start: { cx: layer.cx, cy: layer.cy, w: layer.w, h: layer.h },
    axes,
  };
}

/**
 * Whether an intent should select the layer it names.
 *
 * 📌 Every layer hit selects, including one that cannot be dragged — which is
 * the distinction `select-only` exists to carry.
 */
export function selectsLayer(intent: DragIntent): boolean {
  return intent.kind === 'move' || intent.kind === 'select-only';
}
