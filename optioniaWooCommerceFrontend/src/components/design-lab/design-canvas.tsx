'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { DesignStore } from '@/lib/design-lab/store';
import type { EditorLayer } from '@/lib/design-lab/layer.types';
import { type DragIntent, dragIntentFor, type HitKind, selectsLayer } from '@/lib/design-lab/drag-dispatch';
import { moveTo, resizeFrom, rotateTo } from '@/lib/design-lab/drag-geometry';
import {
  drawnSelectionRect,
  handlesFor,
  layerCursor,
  showsHandles,
} from '@/lib/design-lab/selection-box';

import './design-lab.css';

/**
 * The Design Lab canvas: layers, the selection overlay, and the pointer
 * gestures that move them.
 *
 * 🔴 **This file is the DOM, and almost nothing else.** Every decision it makes
 * was extracted first — `drag-dispatch` decides what a mousedown starts,
 * `drag-geometry` does the arithmetic, `selection-box` sizes the overlay. What
 * is left here is `closest()`, `getBoundingClientRect`, two document listeners
 * and a subscription.
 *
 * ⚠️ **That split is deliberate and the honest part of it is this: what remains
 * here is NOT unit-tested, and has NOT been run.** This project has no JSX test
 * runner (`@vitejs/plugin-react` wants Babel 8 against a Babel 7 toolchain), and
 * the Design Lab has no route until M26d.4 — so the event plumbing is verified
 * by a gate and by reading, and by nothing else. Pushing the decisions out was
 * the way to make that unverified surface small enough that reading it is
 * sufficient; it is not a claim that it was exercised.
 *
 * 📌 **Crop mode is M26d.2**, and with it the double-click handler. The source
 * dispatcher opens with three crop branches and binds `onDoubleClick` to toggle
 * crop on a shaped layer; `store.cropping` is always null until that stage, so
 * all four would be unreachable code here. They arrive together with the
 * feature, because a double-click that toggles nothing is worse than none.
 *
 * ⚠️ **Shaped layers are M26d.2 too.** Every layer currently draws as a plain
 * box: the frame clip-paths, the inner image placement and the crop overlay all
 * belong to that stage. `shape` already rides on the type and through
 * {@link resizeFrom}'s aspect lock, so the frames arrive without disturbing
 * this file's geometry.
 */

/** Marks the drag surface — a click on the surround deselects, as on the canvas. */
const STAGE_CLASS = 'optionia-designlab-stage';
const LAYER_CLASS = 'optionia-designlab-layer';
const BG_LAYER_CLASS = 'optionia-designlab-bg-layer';
const SEL_BOX_CLASS = 'optionia-designlab-sel-box';
const HANDLE_CLASS = 'optionia-designlab-handle-pt';
const ROTATE_CLASS = 'optionia-designlab-rotate-pt';

/**
 * A gesture in progress.
 *
 * ⚠️ **`scale` is FROZEN at pointer-down, and that is load-bearing.** Client
 * pixels become canvas pixels by dividing by the canvas scale; reading it live
 * means a zoom mid-drag re-divides the whole accumulated delta and the layer
 * jumps. The source hook records the same warning.
 */
interface ActiveDrag {
  intent: DragIntent;
  layer: EditorLayer;
  startX: number;
  startY: number;
  scale: number;
  /** Rotation only: the selection box's screen centre and the opening angle. */
  pivotX?: number;
  pivotY?: number;
  startAngle?: number;
  /** Whether anything actually moved, so a click does not push a history entry. */
  changed: boolean;
}

/** What the pointer landed on, resolved from the DOM. */
function resolveHit(target: HTMLElement): {
  hit: HitKind;
  layerId: string | null;
  handleDir?: string;
} {
  const selBox = target.closest(`.${SEL_BOX_CLASS}`) as HTMLElement | null;

  /*
   * 📌 Handles only exist inside a selection box, so a handle with no box is a
   * stray element rather than a gesture — the source makes the same pairing.
   */
  if (selBox) {
    const boxId = selBox.dataset.id ?? null;

    if (target.closest(`.${ROTATE_CLASS}`)) {
      return { hit: 'rotate-handle', layerId: boxId };
    }

    const handle = target.closest(`.${HANDLE_CLASS}`) as HTMLElement | null;

    if (handle) {
      return { hit: 'resize-handle', layerId: boxId, handleDir: handle.dataset.h };
    }
  }

  const layerEl = target.closest(
    `.${LAYER_CLASS}:not(.${BG_LAYER_CLASS})`,
  ) as HTMLElement | null;

  if (layerEl) {
    return { hit: 'layer', layerId: layerEl.dataset.id ?? null };
  }

  return { hit: 'empty', layerId: null };
}

export function DesignCanvas({ store }: Readonly<{ store: DesignStore }>) {
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);

  /*
   * 🔴 The store mutates in place and notifies; `useSyncExternalStore` is how a
   * mutable store drives React without the editor reconciling on every pointer
   * move. The snapshot is a version counter rather than state — the component
   * reads the store directly below, so a structural snapshot would allocate on
   * every frame and defeat the point.
   */
  useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.version,
    () => store.version,
  );

  /* Register the three elements the fit measures and writes. */
  useEffect(() => {
    store.attachStage({
      stage: stageRef.current,
      wrap: wrapRef.current,
      scale: scaleRef.current,
    });
    store.fitCanvas();

    const onResize = () => store.fitCanvas();

    window.addEventListener('resize', onResize);

    let observer: ResizeObserver | undefined;

    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      observer = new ResizeObserver(() => store.fitCanvas());
      observer.observe(stageRef.current);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      store.attachStage(null);
    };
  }, [store]);

  /*
   * ⚠️ **Re-fit after every render, deliberately dependency-free.** A layout
   * change with no window resize — a panel opening, the viewport settling after
   * fonts load — moves the stage without firing an event. `canvasScale` is the
   * divisor for every drag delta, so a stale one makes dragging wrong by a
   * factor while the canvas still LOOKS correct, which is the hardest kind of
   * wrong to see. The ResizeObserver above catches most of it; this catches the
   * rest, and `fitCanvas` writes nothing when the numbers have not moved.
   */
  useEffect(() => {
    store.fitCanvas();
  });

  function onMouseDown(e: React.MouseEvent) {
    const { hit, layerId, handleDir } = resolveHit(e.target as HTMLElement);
    const layer = layerId ? (store.layers.find((l) => l.id === layerId) ?? null) : null;
    const intent = dragIntentFor(hit, layer, { cw: store.cw, ch: store.ch }, handleDir);

    if (intent.kind === 'deselect') {
      if (store.selectedId !== null) store.select(null);

      return;
    }

    if (intent.kind === 'none' || !layer) return;

    e.preventDefault();

    /*
     * ⚠️ Selection before the drag decision, and through `select()` rather than
     * by assigning `selectedId` — the setter is what notifies subscribers, and
     * a locked layer must still select so the merchant can reach the control
     * that unlocks it.
     */
    if (selectsLayer(intent) && store.selectedId !== layer.id) {
      store.select(layer.id);
    }

    if (intent.kind === 'select-only') return;

    const drag: ActiveDrag = {
      intent,
      layer,
      startX: e.clientX,
      startY: e.clientY,
      scale: store.canvasScale,
      changed: false,
    };

    if (intent.kind === 'rotate') {
      /*
       * 🔴 **The one thing only a browser can answer.** Rotation is measured
       * from the selection box's SCREEN centre, which no amount of extraction
       * can compute — it depends on layout, scroll and the page transform.
       */
      const selBox = (e.target as HTMLElement).closest(
        `.${SEL_BOX_CLASS}`,
      ) as HTMLElement | null;

      if (!selBox) return;

      const rect = selBox.getBoundingClientRect();

      drag.pivotX = rect.left + rect.width / 2;
      drag.pivotY = rect.top + rect.height / 2;
      drag.startAngle = Math.atan2(e.clientY - drag.pivotY, e.clientX - drag.pivotX);
    }

    dragRef.current = drag;
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragRef.current;

      if (!drag) return;

      drag.changed = true;
      overlayRef.current?.classList.add('optionia-designlab-is-dragging');

      const { intent, layer } = drag;

      if (intent.kind === 'rotate') {
        layer.rot = rotateTo(
          { x: e.clientX, y: e.clientY },
          { x: drag.pivotX!, y: drag.pivotY! },
          drag.startAngle!,
          intent.startRotationDeg,
          e.shiftKey,
        );
        store.notify();

        return;
      }

      /* Client pixels → canvas pixels, at the scale frozen when the drag began. */
      const dx = (e.clientX - drag.startX) / drag.scale;
      const dy = (e.clientY - drag.startY) / drag.scale;

      if (intent.kind === 'move') {
        const next = moveTo(
          intent.start,
          { dx, dy },
          intent.axes,
          { w: layer.w, h: layer.h },
          { cw: store.cw, ch: store.ch },
        );

        layer.cx = next.cx;
        layer.cy = next.cy;
        store.notify();

        return;
      }

      if (intent.kind === 'resize') {
        const next = resizeFrom(
          intent.start,
          { dx, dy },
          intent.dir,
          layer.rot,
          layer.shape,
        );

        layer.cx = next.cx;
        layer.cy = next.cy;
        layer.w = next.w;
        layer.h = next.h;
        store.notify();
      }
    }

    function onUp() {
      const drag = dragRef.current;

      /*
       * 📌 **The commit/notify split closes here.** A gesture notifies on every
       * frame and commits ONCE, on release — and only if something moved, so a
       * plain click does not fill the undo stack with no-ops.
       */
      if (drag?.changed) store.commit();

      dragRef.current = null;
      overlayRef.current?.classList.remove('optionia-designlab-is-dragging');
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [store]);

  const selected = store.getSelected();
  const showSelection = selected && selected.kind !== 'background' && selected.visible;

  return (
    <div className={STAGE_CLASS} ref={stageRef} onMouseDown={onMouseDown}>
      <div className="optionia-designlab-canvas-wrap" ref={wrapRef}>
        <div className="optionia-designlab-canvas-scale" ref={scaleRef}>
          <div
            className={
              'optionia-designlab-canvas' +
              (store.checker ? ' optionia-designlab-checker' : '')
            }
            style={{
              width: store.cw,
              height: store.ch,
              background: store.bg === 'transparent' ? 'transparent' : store.bg,
            }}
          >
            {store.layers.map((layer) =>
              layer.visible ? (
                <LayerElement key={layer.id} layer={layer} cw={store.cw} ch={store.ch} />
              ) : null,
            )}
          </div>
          <div className="optionia-designlab-canvas-overlay" ref={overlayRef}>
            {showSelection ? (
              <SelectionBox layer={selected} cw={store.cw} ch={store.ch} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One layer on the canvas. Shaped frames are M26d.2 — see the file header. */
function LayerElement({
  layer,
  cw,
  ch,
}: Readonly<{ layer: EditorLayer; cw: number; ch: number }>) {
  if (layer.kind === 'background') {
    return (
      <div
        className={`${LAYER_CLASS} ${BG_LAYER_CLASS}`}
        data-id={layer.id}
        style={{ position: 'absolute', left: 0, top: 0, width: cw, height: ch }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={layer.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
    );
  }

  return (
    <div
      /*
       * ⚠️ **No `selected` class, deliberately.** In the source it carries one
       * declaration on a layer — `cursor: move` — which `layerCursor` now
       * computes properly, including the pinned and locked cases the blanket
       * rule got wrong. The selection is DRAWN by the overlay's box, not by a
       * class on the layer, so emitting one that styles nothing would be a
       * hook for a rule that should never be written.
       */
      className={LAYER_CLASS + (layer.locked ? ' optionia-designlab-locked' : '')}
      data-id={layer.id}
      style={{
        position: 'absolute',
        left: layer.cx - layer.w / 2,
        top: layer.cy - layer.h / 2,
        width: layer.w,
        height: layer.h,
        transform: `rotate(${layer.rot}deg)`,
        opacity: layer.opacity < 100 ? layer.opacity / 100 : undefined,
        /*
         * 🔴 The only signal that a layer cannot be dragged. `layerCursor`
         * reads the same `moveAxes` the dispatcher does, so the cursor says
         * `default` on exactly the layers that answer `select-only`.
         */
        cursor: layerCursor(layer, cw, ch),
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={layer.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
    </div>
  );
}

/** The dashed box and its grips, sized by {@link drawnSelectionRect}. */
function SelectionBox({
  layer,
  cw,
  ch,
}: Readonly<{ layer: EditorLayer; cw: number; ch: number }>) {
  const rect = drawnSelectionRect(layer, cw, ch);
  const withHandles = showsHandles(layer);

  return (
    <div
      className={SEL_BOX_CLASS}
      data-id={layer.id}
      style={{
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.w,
        height: rect.h,
        transform: `rotate(${layer.rot}deg)`,
      }}
    >
      {withHandles &&
        handlesFor(layer).map((dir) => (
          <div className={HANDLE_CLASS} data-h={dir} key={dir} />
        ))}
      {withHandles && <div className="optionia-designlab-rotate-stem" />}
      {withHandles && (
        <div className={ROTATE_CLASS} data-h="rotate" title="Drag to rotate" />
      )}
    </div>
  );
}
