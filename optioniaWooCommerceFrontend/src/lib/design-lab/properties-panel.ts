import type { EditorLayer } from './layer.types';

/**
 * Which property controls a selected layer may use.
 *
 * 🔴 **Three predicates, and they are not the same one.** A locked layer edits
 * nothing; an aligned layer still edits unless its style already fills both
 * axes; rotation needs free placement specifically. Written inline in a panel
 * they look interchangeable, and collapsing them into one "enabled" flag is the
 * obvious simplification that would quietly disable controls that should work.
 *
 * ⚠️ **These answer the same question the canvas answers with a cursor.** The
 * panel and the canvas must agree about a locked or pinned layer, or a merchant
 * is offered a slider that moves nothing.
 */

/**
 * Whether the layer's properties can be edited at all.
 *
 * 📌 **Lock is the whole rule.** Visibility is not: a hidden layer is still
 * editable, because hiding is a view state the merchant toggles while composing,
 * not a freeze.
 */
export function isEditable(layer: EditorLayer | null): boolean {
  return layer !== null && !layer.locked;
}

/**
 * Whether the align controls apply.
 *
 * ⚠️ **Only `cover` is excluded, not every non-free style.** A `fit`, `fullw` or
 * `fullh` layer still has a free axis to align along — `fullw` spans the width
 * but can sit at the top, middle or bottom. Excluding them would disable a
 * control that works, which is the mistake this comment exists to prevent.
 * `cover` fills both axes by definition, so there is nothing to align.
 */
export function canAlign(layer: EditorLayer | null): boolean {
  /*
   * 📌 Narrowed by an explicit null check rather than a `!` assertion: an
   * assertion would keep compiling if `isEditable` ever stopped implying
   * non-null, and would then read a property of nothing at runtime.
   */
  if (layer === null || !isEditable(layer)) return false;

  return layer.style !== 'cover';
}

/**
 * Whether rotation applies.
 *
 * 🔴 **Free placement only, and this is narrower than `canAlign` on purpose.**
 * Every other style derives the layer's box from the canvas on each re-fit —
 * `applyStyleGeometry` recomputes it — so a rotation would be computed against a
 * box the style is about to overwrite. The angle would survive in the data and
 * be visibly ignored.
 */
export function canRotate(layer: EditorLayer | null): boolean {
  if (layer === null || !isEditable(layer)) return false;

  return layer.style === 'free';
}

/**
 * Whether the opacity slider applies.
 *
 * 📌 **Any editable layer.** Opacity is independent of placement — it is the one
 * property no fit mode recomputes.
 */
export function canSetOpacity(layer: EditorLayer | null): boolean {
  return isEditable(layer);
}

/** Every enablement the panel needs, resolved once. */
export interface PanelState {
  editable: boolean;
  align: boolean;
  rotate: boolean;
  opacity: boolean;
  style: boolean;
}

/**
 * The panel's enablement, for a selected layer or for nothing.
 *
 * ⚠️ **With no selection every control is off.** The panel still renders — it
 * holds its place rather than collapsing the layout — but nothing in it acts on
 * a layer that is not there.
 */
export function panelState(layer: EditorLayer | null): PanelState {
  const editable = isEditable(layer);

  return {
    editable,
    align: canAlign(layer),
    rotate: canRotate(layer),
    opacity: canSetOpacity(layer),
    /* The fit mode itself is editable whenever the layer is. */
    style: editable,
  };
}
