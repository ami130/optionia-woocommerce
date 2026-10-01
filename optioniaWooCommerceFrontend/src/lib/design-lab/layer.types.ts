import type { LayerShape, LayerStyle } from '@shared/design/design-geometry.types';

/**
 * A layer as the EDITOR holds it — absolute canvas pixels, mutable.
 *
 * 🔴 **The other side of persistence from `DesignLayer`.** The shared type
 * stores fractions of the canvas so a design re-places at any size; this one
 * carries `cx/cy/w/h` in the editor's own pixels, because a canvas mutates on
 * every pointer move and converting on each one would be arithmetic nobody
 * needs. The two meet at export and import, and nowhere else.
 *
 * ⚠️ **Mutable by design.** The store writes these fields in place and notifies
 * subscribers; the plan calls that choice load-bearing — *"a canvas mutates on
 * every pointer move, and reconciliation on each one is why naive
 * implementations feel laggy."*
 */
export interface EditorLayer {
  id: string;
  name: string;
  src: string;
  /** The image's natural pixel dimensions, as the browser reports them. */
  natW: number;
  natH: number;
  kind: 'layer' | 'background';
  /** Centre and size in CANVAS pixels — not fractions. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Degrees. */
  rot: number;
  style: LayerStyle;
  /** 0–100; 100 is fully opaque. */
  opacity: number;
  /**
   * Frame mask; `none` is a plain layer.
   *
   * ⚠️ **`square` frames size freely (w and h independent); every other shape
   * keeps `w === h`.** That split is why {@link applyStyleGeometry} has three
   * branches rather than one.
   */
  shape: LayerShape;
  /** Custom PNG mask URL when `shape === 'image'`. */
  shapeSrc?: string;
  visible: boolean;
  locked: boolean;
}
