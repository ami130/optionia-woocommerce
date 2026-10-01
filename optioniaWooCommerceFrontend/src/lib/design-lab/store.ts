import type { LayerShape, LayerStyle } from '@shared/design/design-geometry.types';

import type { EditorLayer } from './layer.types';
import { CANVAS_BASE_H, applyStyleGeometry, freeDefaultSize } from './style-geometry';

/**
 * The Design Lab's state engine (M26d.1).
 *
 * 🔴 **An explicit store with subscribe/notify, not React state, and the plan
 * calls that choice load-bearing** — *"a canvas mutates on every pointer move,
 * and reconciliation on each one is why naive implementations feel laggy."*
 * Ported from `optionia-app/app/components/design-lab/store.ts`.
 *
 * ⚠️ **Framework-free.** No React, no DOM at module load. The canvas hands it
 * element references later and every method that uses them returns early when
 * they are absent, which is what makes this testable without a browser.
 *
 * 📌 **Scope is M26d.1.** Frames, masks and cropping are M26d.2; the gallery
 * bridges are M26d.5. Two methods here carry a crop GUARD — see
 * {@link DesignStore.inCropMode} — which is unreachable until frames exist and
 * is kept rather than stripped, because re-deriving it later is the
 * re-derivation this port exists to avoid.
 */

/** History depth. Eighty snapshots of a few dozen layers is cheap; unbounded is not. */
const HISTORY_LIMIT = 80;

/** How far a duplicate is offset from its original, in canvas pixels. */
const DUPLICATE_OFFSET = 16;

interface Snapshot {
  layers: EditorLayer[];
  selectedId: string | null;
  bg: string;
  checker: boolean;
  cw: number;
  ch: number;
}

let counter = 0;

function nextId(): string {
  counter += 1;

  return `L${counter}`;
}

export class DesignStore {
  /* ----- canonical state ----- */
  layers: EditorLayer[] = [];
  selectedId: string | null = null;
  /**
   * The layer currently in crop mode.
   *
   * ⚠️ **Always null until M26d.2.** Nothing here sets it; it exists so the
   * guards that read it are ported whole rather than re-derived later.
   */
  cropping: string | null = null;
  bg = '#ffffff';
  checker = false;
  cw = 392;
  ch = 464;
  canvasScale = 1;

  /* ----- history ----- */
  private history: string[] = [];
  private hidx = -1;
  private suppressHistory = false;

  /* ----- DOM refs, set by the canvas component ----- */
  stageEl: { clientWidth: number; clientHeight: number } | null = null;
  wrapEl: { style: Record<string, string> } | null = null;
  scaleEl: { style: Record<string, string> } | null = null;

  /* ----- subscription ----- */
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);

    return () => {
      this.listeners.delete(fn);
    };
  }

  notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /* ---------- canvas sizing ---------- */

  /**
   * Adopt a new background's aspect.
   *
   * 📌 **The canvas keeps a fixed logical HEIGHT and the width follows**, so a
   * design composed against one product photo re-places sensibly against
   * another of a different shape.
   */
  setCanvasSize(natW: number, natH: number): void {
    if (!natW || !natH) return;

    const newH = CANVAS_BASE_H;
    const newW = Math.round(newH * (natW / natH));
    const sx = newW / this.cw;
    const sy = newH / this.ch;

    if (sx === 1 && sy === 1) return;

    this.cw = newW;
    this.ch = newH;

    this.layers.forEach((layer) => {
      if (layer.kind === 'background') {
        layer.cx = newW / 2;
        layer.cy = newH / 2;
        layer.w = newW;
        layer.h = newH;

        return;
      }

      /* Keep the relative position; re-derive the size from the style. */
      layer.cx *= sx;
      layer.cy *= sy;

      if (layer.style === 'free') {
        layer.w *= sx;

        /*
         * ⚠️ **Each shape scales differently, and the distinctions are not
         * cosmetic.** A plain layer keeps the IMAGE's aspect; a `square` frame
         * keeps its own fractions so the image re-covers without stretching; a
         * custom PNG mask scales uniformly so its own aspect survives; every
         * other frame is ratio-locked to a square.
         */
        if (layer.shape === 'none') {
          layer.h = layer.w * (layer.natH / layer.natW);
        } else if (layer.shape === 'square') {
          layer.h *= sy;
        } else if (layer.shape === 'image') {
          layer.h *= sx;
        } else {
          layer.h = layer.w;
        }
      } else {
        applyStyleGeometry(layer, newW, newH);
      }
    });
  }

  /* ---------- history ---------- */

  private serialize(): string {
    return JSON.stringify({
      layers: this.layers,
      selectedId: this.selectedId,
      bg: this.bg,
      checker: this.checker,
      cw: this.cw,
      ch: this.ch,
    });
  }

  /**
   * Push the current state onto the undo stack.
   *
   * 🔴 **Called by DISCRETE acts, never by continuous ones.** Adding, deleting,
   * reordering, locking and changing a style each commit; dragging, nudging and
   * the opacity and rotation sliders only {@link notify}. The components
   * debounce a commit when the gesture ends — 250ms after a slider, 400ms after
   * a nudge, immediately on drag release.
   *
   * ⚠️ **Committing in every setter would fill all eighty entries with one
   * slider drag**, and undo would step back a pixel at a time. The store does
   * not know when a gesture ends, and deliberately does not try to.
   */
  commit(): void {
    if (this.suppressHistory) return;

    this.history = this.history.slice(0, this.hidx + 1);
    this.history.push(this.serialize());

    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }

    this.hidx = this.history.length - 1;
  }

  private restore(serialized: string): void {
    const snapshot: Snapshot = JSON.parse(serialized);

    /*
     * ⚠️ **The layer array is REPLACED, not patched.** Anything holding a layer
     * reference across an undo holds a stale object — components must read
     * through the store after every notify rather than caching.
     */
    this.layers = snapshot.layers;
    this.selectedId = snapshot.selectedId;
    this.bg = snapshot.bg;
    this.checker = snapshot.checker;

    if (snapshot.cw && snapshot.ch) {
      this.cw = snapshot.cw;
      this.ch = snapshot.ch;
    }

    this.fitCanvas();
    this.notify();
  }

  undo(): void {
    if (this.hidx > 0) {
      this.hidx -= 1;
      this.restore(this.history[this.hidx]);
    }
  }

  redo(): void {
    if (this.hidx < this.history.length - 1) {
      this.hidx += 1;
      this.restore(this.history[this.hidx]);
    }
  }

  canUndo(): boolean {
    return this.hidx > 0;
  }

  canRedo(): boolean {
    return this.hidx < this.history.length - 1;
  }

  /* ---------- layers ---------- */

  backgroundLayer(): EditorLayer | null {
    return this.layers.find((l) => l.kind === 'background') ?? null;
  }

  getSelected(): EditorLayer | null {
    return this.layers.find((l) => l.id === this.selectedId) ?? null;
  }

  addLayer(
    src: string,
    name: string,
    natW: number,
    natH: number,
    opts: Partial<EditorLayer> = {},
  ): EditorLayer {
    const size = freeDefaultSize(natW, natH, this.cw, this.ch);

    const layer: EditorLayer = {
      id: nextId(),
      name: name || `Layer ${counter}`,
      src,
      natW,
      natH,
      kind: 'layer',
      cx: this.cw / 2,
      cy: this.ch / 2,
      w: size.w,
      h: size.h,
      rot: 0,
      style: 'free',
      opacity: 100,
      shape: 'none',
      visible: true,
      locked: false,
      ...opts,
    };

    this.layers.push(layer);

    if (layer.kind !== 'background') {
      this.selectedId = layer.id;
    }

    this.commit();
    this.notify();

    return layer;
  }

  /**
   * ⚠️ **A deep copy, offset so the duplicate is visible.** Inserted directly
   * above its original rather than on top of the stack, so duplicating a layer
   * in the middle of a design does not reorder it.
   */
  duplicateLayer(layer: EditorLayer | null): void {
    if (!layer || layer.kind === 'background') return;

    const copy: EditorLayer = JSON.parse(JSON.stringify(layer));

    copy.id = nextId();
    copy.cx += DUPLICATE_OFFSET;
    copy.cy += DUPLICATE_OFFSET;

    this.layers.splice(this.layers.indexOf(layer) + 1, 0, copy);
    this.selectedId = copy.id;
    this.commit();
    this.notify();
  }

  duplicateSelected(): void {
    this.duplicateLayer(this.getSelected());
  }

  removeLayerById(id: string): void {
    this.layers = this.layers.filter((l) => l.id !== id);

    if (this.cropping === id) {
      this.cropping = null;
    }

    if (this.selectedId === id) {
      /* Select the topmost remaining overlay, never the background. */
      const overlays = this.layers.filter((l) => l.kind !== 'background');

      this.selectedId = overlays.length ? overlays[overlays.length - 1].id : null;
    }

    this.commit();
    this.notify();
  }

  /** 🔴 **The background cannot be deleted** — it is the product photo. */
  deleteLayer(id: string): void {
    const layer = this.layers.find((l) => l.id === id);

    if (!layer || layer.kind === 'background') return;

    this.removeLayerById(id);
  }

  toggleLock(layer: EditorLayer): void {
    layer.locked = !layer.locked;
    this.commit();
    this.notify();
  }

  toggleVisible(layer: EditorLayer): void {
    layer.visible = !layer.visible;
    this.commit();
    this.notify();
  }

  select(id: string | null): void {
    /* Selecting away from a cropped layer ends crop mode and commits its edits. */
    if (this.cropping !== null && this.cropping !== id) {
      this.cropping = null;
      this.commit();
    }

    this.selectedId = id;
    this.notify();
  }

  /**
   * Reorder overlays; the background stays at the bottom.
   *
   * ⚠️ **The list is top-to-bottom and `layers` is bottom-to-top**, so the ids
   * are reversed before sorting. Getting that backwards inverts the whole stack
   * silently.
   */
  reorderByIds(topToBottomIds: string[]): void {
    const order = [...topToBottomIds].reverse();

    this.layers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    const bgIndex = this.layers.findIndex((l) => l.kind === 'background');

    if (bgIndex > 0) {
      const [background] = this.layers.splice(bgIndex, 1);

      this.layers.unshift(background);
    }

    this.commit();
    this.notify();
  }

  /* ---------- style, alignment, transform ---------- */

  /**
   * Whether the selected layer is the one being cropped.
   *
   * ⚠️ **Always false until M26d.2.** `shape` is `none` on every layer this
   * milestone can create and `cropping` is never set — so each branch guarded
   * by this is unreachable. Ported whole rather than stripped: re-deriving the
   * mode-aware behaviour when frames land is exactly the re-derivation this
   * port exists to avoid.
   */
  private inCropMode(layer: EditorLayer): boolean {
    return layer.shape !== 'none' && this.cropping === layer.id;
  }

  setStyle(style: LayerStyle): void {
    const layer = this.getSelected();

    if (!layer) return;

    /* Crop mode fits the IMAGE to its frame; otherwise the FRAME to the canvas. */
    if (!this.inCropMode(layer)) {
      layer.style = style;
      applyStyleGeometry(layer, this.cw, this.ch);
    }

    this.commit();
    this.notify();
  }

  alignH(to: 'left' | 'hcenter' | 'right'): void {
    const layer = this.getSelected();

    if (!layer || this.inCropMode(layer)) return;

    if (to === 'left') layer.cx = layer.w / 2;
    if (to === 'hcenter') layer.cx = this.cw / 2;
    if (to === 'right') layer.cx = this.cw - layer.w / 2;

    this.commit();
    this.notify();
  }

  alignV(to: 'top' | 'vcenter' | 'bottom'): void {
    const layer = this.getSelected();

    if (!layer || this.inCropMode(layer)) return;

    if (to === 'top') layer.cy = layer.h / 2;
    if (to === 'vcenter') layer.cy = this.ch / 2;
    if (to === 'bottom') layer.cy = this.ch - layer.h / 2;

    this.commit();
    this.notify();
  }

  /**
   * ⚠️ **Notifies without committing** — a rotation slider drags continuously,
   * and the control commits once on release. See {@link commit}.
   */
  setRotation(deg: number): void {
    const layer = this.getSelected();

    if (!layer) return;

    layer.rot = deg;
    this.notify();
  }

  /** ⚠️ **Notifies without committing**, for the same reason as rotation. */
  setOpacity(pct: number): void {
    const layer = this.getSelected();

    if (!layer) return;

    layer.opacity = Math.max(0, Math.min(100, Math.round(pct)));
    this.notify();
  }

  /**
   * Move the selection by a keyboard step.
   *
   * ⚠️ **Notifies without committing**, and refuses a locked layer. The caller
   * debounces a commit so a run of arrow presses is one undo step, not twenty.
   */
  nudge(dx: number, dy: number): void {
    const layer = this.getSelected();

    if (!layer || layer.locked) return;

    layer.cx += dx;
    layer.cy += dy;
    this.notify();
  }

  setShapeOn(layer: EditorLayer, shape: LayerShape): void {
    layer.shape = shape;
    this.commit();
    this.notify();
  }

  setBg(colour: string): void {
    this.bg = colour;
    this.commit();
    this.notify();
  }

  setChecker(on: boolean): void {
    this.checker = on;
    this.commit();
    this.notify();
  }

  /* ---------- canvas fit ---------- */

  /**
   * Scale the canvas into its available area.
   *
   * ⚠️ **Returns early without DOM refs**, which is what lets the store be
   * tested headlessly — `restore()` calls this on every undo.
   */
  fitCanvas(): void {
    const stage = this.stageEl;
    const wrap = this.wrapEl;
    const scale = this.scaleEl;

    if (!stage || !wrap || !scale) return;

    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;

    if (stageW <= 0 || stageH <= 0) return;

    const padY = Math.max(12, Math.min(20, stageH * 0.05));
    const padX = Math.max(16, Math.min(60, stageW * 0.09));
    const availW = stageW - 2 * padX;
    const availH = stageH - 2 * padY;

    if (availW <= 0 || availH <= 0) return;

    let s = Math.min(availW / this.cw, availH / this.ch);

    s = Math.max(0.1, Math.min(s, 1.6));
    this.canvasScale = s;

    scale.style.width = `${this.cw}px`;
    scale.style.height = `${this.ch}px`;
    scale.style.transformOrigin = 'top left';
    scale.style.transform = `scale(${s})`;
    wrap.style.width = `${Math.round(this.cw * s)}px`;
    wrap.style.height = `${Math.round(this.ch * s)}px`;
  }
}
