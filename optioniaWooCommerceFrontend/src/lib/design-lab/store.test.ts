import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignStore, designLayerToEditor, editorLayerToDesign } from './store';

/**
 * The state engine M26d.1 calls load-bearing.
 *
 * 🔴 **Headless, which is the property that makes it testable at all.** No
 * React, no DOM at module load, and every method touching element references
 * returns early without them — so the behaviour that matters is reachable
 * without a browser, and this project has no JSX runner.
 */

function store(): DesignStore {
  const s = new DesignStore();

  /* A known canvas, so sizes below are arithmetic rather than incidental. */
  s.cw = 400;
  s.ch = 460;
  s.commit();

  return s;
}

function addThree(s: DesignStore): string[] {
  return [
    s.addLayer('a.png', 'A', 200, 100).id,
    s.addLayer('b.png', 'B', 200, 100).id,
    s.addLayer('c.png', 'C', 200, 100).id,
  ];
}

describe('layers', () => {
  it('adds a layer, selects it, and sizes it by the free default', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    expect(s.layers).toHaveLength(1);
    expect(s.selectedId).toBe(layer.id);
    /* 2:1 on a 400x460 canvas constrains by width: half of 400. */
    expect(layer.w).toBeCloseTo(200, 6);
    expect(layer.h).toBeCloseTo(100, 6);
  });

  it('duplicates directly above the original, offset so it is visible', () => {
    const s = store();
    const [first] = addThree(s);

    s.duplicateLayer(s.layers[0]);

    expect(s.layers).toHaveLength(4);
    /* Immediately above its original — not on top of the stack. */
    expect(s.layers[1].id).not.toBe(first);
    expect(s.layers[1].cx).toBeCloseTo(s.layers[0].cx + 16, 6);
    expect(s.selectedId).toBe(s.layers[1].id);
  });

  it('refuses to duplicate the background', () => {
    const s = store();

    s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });
    s.duplicateLayer(s.backgroundLayer());

    expect(s.layers).toHaveLength(1);
  });

  it('refuses to delete the background', () => {
    const s = store();
    const bg = s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });

    s.deleteLayer(bg.id);

    expect(s.backgroundLayer()).not.toBeNull();
  });

  it('selects the topmost remaining overlay when the selected one goes', () => {
    const s = store();
    const ids = addThree(s);

    s.select(ids[2]);
    s.removeLayerById(ids[2]);

    expect(s.selectedId).toBe(ids[1]);
  });

  it('selects nothing when the last overlay goes, never the background', () => {
    const s = store();

    s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });

    const only = s.addLayer('a.png', 'A', 200, 100);

    s.removeLayerById(only.id);

    expect(s.selectedId).toBeNull();
  });

  /**
   * 🔴 **The list is top-to-bottom; `layers` is bottom-to-top.** Getting that
   * backwards inverts the whole stack silently, which is why the reversal is
   * asserted rather than assumed.
   */
  it('reorders from a top-to-bottom list and keeps the background at the bottom', () => {
    const s = store();

    s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });

    const ids = addThree(s);

    s.reorderByIds([ids[0], ids[2], ids[1]]);

    expect(s.layers[0].kind).toBe('background');
    /* Bottom-to-top is the reverse of what was asked for. */
    expect(s.layers.slice(1).map((l) => l.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('toggles lock and visibility independently', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    s.toggleLock(layer);
    s.toggleVisible(layer);

    expect(layer.locked).toBe(true);
    expect(layer.visible).toBe(false);
  });
});

describe('history', () => {
  it('undoes and redoes a discrete change', () => {
    const s = store();

    s.addLayer('a.png', 'A', 200, 100);
    expect(s.layers).toHaveLength(1);

    s.undo();
    expect(s.layers).toHaveLength(0);

    s.redo();
    expect(s.layers).toHaveLength(1);
  });

  it('reports what it can do, so a toolbar can disable itself', () => {
    const s = store();

    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);

    s.addLayer('a.png', 'A', 200, 100);
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);

    s.undo();
    expect(s.canRedo()).toBe(true);
  });

  it('drops the redo branch once a new change lands', () => {
    const s = store();

    s.addLayer('a.png', 'A', 200, 100);
    s.addLayer('b.png', 'B', 200, 100);
    s.undo();

    expect(s.canRedo()).toBe(true);

    s.addLayer('c.png', 'C', 200, 100);

    /* The future that was undone is gone — a branch, not a stack. */
    expect(s.canRedo()).toBe(false);

    /*
     * 🔴 **`canRedo()` alone does not prove this, and a mutation showed it.**
     * Removing the `slice` that truncates the branch left `hidx` at the end, so
     * `canRedo()` was false either way and the assertion above passed — while
     * the abandoned state stayed in the array, reachable by UNDO.
     *
     * The property that matters: undoing from here reaches the state we
     * branched FROM (A alone), never the one we abandoned (A and B).
     */
    s.undo();

    expect(s.layers.map((l) => l.name)).toEqual(['A']);
  });

  it('caps the history rather than growing without bound', () => {
    const s = store();

    /* 120 discrete changes against a limit of 80. */
    for (let i = 0; i < 120; i++) {
      s.addLayer(`l${i}.png`, `L${i}`, 200, 100);
    }

    let undos = 0;

    while (s.canUndo() && undos < 500) {
      s.undo();
      undos += 1;
    }

    expect(undos).toBeLessThan(100);
    /* The oldest states fell off, so undo cannot reach an empty canvas. */
    expect(s.layers.length).toBeGreaterThan(0);
  });

  it('restores a REPLACED array, so a held reference goes stale', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    s.addLayer('b.png', 'B', 200, 100);
    s.undo();

    /*
     * ⚠️ Documented rather than wished away: `restore` parses a snapshot and
     * replaces `layers` wholesale. A component caching a layer across an undo
     * holds an object the store no longer owns.
     */
    expect(s.layers[0]).not.toBe(layer);
    expect(s.layers[0].id).toBe(layer.id);
  });
});

/**
 * 🔴 **Which mutations enter history, asserted by name.**
 *
 * Discrete acts commit; continuous gestures only notify, and the components
 * debounce a commit when the gesture ends — 250ms after a slider, 400ms after a
 * nudge, immediately on drag release.
 *
 * ⚠️ **A well-meaning refactor that committed in every setter would fill all
 * eighty entries with one slider drag**, and undo would step back a pixel at a
 * time. Nothing but these cases would notice.
 */
describe('the commit / notify split', () => {
  let s: DesignStore;

  beforeEach(() => {
    s = store();
    s.addLayer('a.png', 'A', 200, 100);
  });

  function historyDepth(): number {
    let depth = 0;

    while (s.canUndo() && depth < 500) {
      s.undo();
      depth += 1;
    }

    return depth;
  }

  it.each([
    ['setOpacity', () => s.setOpacity(50)],
    ['setRotation', () => s.setRotation(45)],
    ['nudge', () => s.nudge(5, 5)],
  ])('%s notifies without committing', (_name, act) => {
    const before = historyDepth();

    /* Rebuild the state the depth probe just unwound. */
    while (s.canRedo()) s.redo();

    const listener = vi.fn();

    s.subscribe(listener);

    /*
     * ⚠️ The version must move on a gesture, not only on a commit. A drag
     * notifies many times and commits once; if the snapshot React compares
     * only changed on commit, the canvas would redraw on release alone and the
     * layer would teleport rather than follow the pointer.
     */
    const versionBefore = s.version;

    act();

    expect(listener).toHaveBeenCalled();
    expect(s.version).toBeGreaterThan(versionBefore);
    expect(historyDepth()).toBe(before);
  });

  it.each([
    ['setStyle', () => s.setStyle('cover')],
    ['alignH', () => s.alignH('left')],
    ['alignV', () => s.alignV('top')],
    ['toggleLock', () => s.toggleLock(s.getSelected()!)],
    ['setBg', () => s.setBg('#000000')],
  ])('%s commits', (_name, act) => {
    const before = historyDepth();

    while (s.canRedo()) s.redo();

    act();

    expect(historyDepth()).toBe(before + 1);
  });

  it('a run of nudges is one undo step once the caller commits', () => {
    const before = historyDepth();

    while (s.canRedo()) s.redo();

    for (let i = 0; i < 20; i++) s.nudge(1, 0);

    /* The caller's debounce fires once. */
    s.commit();

    expect(historyDepth()).toBe(before + 1);
  });
});

/** The three elements `fitCanvas` measures and writes, as plain objects. */
function stageRefs(clientWidth: number, clientHeight: number) {
  const blank = () => ({ width: '', height: '', transformOrigin: '', transform: '' });

  return {
    stage: { clientWidth, clientHeight },
    wrap: { style: blank() },
    scale: { style: blank() },
  };
}

describe('subscription', () => {
  it('notifies every listener and stops after unsubscribe', () => {
    const s = store();
    const a = vi.fn();
    const b = vi.fn();

    const off = s.subscribe(a);

    s.subscribe(b);
    s.notify();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    off();
    s.notify();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  /*
   * 🔴 The snapshot React compares. The store mutates layers in place, so the
   * layers array is the SAME reference across a drag; without a changing
   * scalar `useSyncExternalStore` sees no change and the canvas freezes
   * mid-gesture while the data underneath is already correct — the hardest
   * kind of bug to read from the screen.
   */
  it('bumps a version on every notify, so a mutable store has a changing snapshot', () => {
    const s = store();
    const first = s.version;

    s.notify();
    s.notify();

    expect(s.version).toBe(first + 2);
  });
});

describe('canvas sizing', () => {
  it('keeps a fixed logical height and follows the aspect in width', () => {
    const s = store();

    s.setCanvasSize(200, 100);

    expect(s.ch).toBe(460);
    expect(s.cw).toBe(920);
  });

  it('does nothing when the aspect is unchanged', () => {
    const s = store();

    s.setCanvasSize(400, 460);

    const w = s.cw;

    s.setCanvasSize(400, 460);

    expect(s.cw).toBe(w);
  });

  it('refuses a degenerate size rather than dividing by zero', () => {
    const s = store();
    const before = s.cw;

    s.setCanvasSize(0, 100);
    s.setCanvasSize(100, 0);

    expect(s.cw).toBe(before);
  });

  it('re-fits a styled layer and scales a free one', () => {
    const s = store();
    const free = s.addLayer('a.png', 'A', 200, 100);

    s.select(free.id);
    s.setStyle('free');

    const covered = s.addLayer('b.png', 'B', 200, 100);

    s.select(covered.id);
    s.setStyle('cover');
    s.setCanvasSize(200, 100);

    /* Cover re-fits to the new canvas and centres. */
    expect(covered.cx).toBeCloseTo(s.cw / 2, 6);
    expect(covered.cy).toBeCloseTo(s.ch / 2, 6);
    /* Free keeps the image's own aspect. */
    expect(free.w / free.h).toBeCloseTo(200 / 100, 6);
  });

  it('stretches the background to the whole canvas', () => {
    const s = store();
    const bg = s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });

    s.setCanvasSize(200, 100);

    expect(bg.w).toBe(s.cw);
    expect(bg.h).toBe(s.ch);
  });
});

describe('transforms', () => {
  it('aligns to each edge and to the centre', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    s.alignH('left');
    expect(layer.cx).toBeCloseTo(layer.w / 2, 6);

    s.alignH('right');
    expect(layer.cx).toBeCloseTo(s.cw - layer.w / 2, 6);

    s.alignV('vcenter');
    expect(layer.cy).toBeCloseTo(s.ch / 2, 6);
  });

  it('clamps opacity into 0..100 and rounds it', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    s.setOpacity(150);
    expect(layer.opacity).toBe(100);

    s.setOpacity(-20);
    expect(layer.opacity).toBe(0);

    s.setOpacity(49.6);
    expect(layer.opacity).toBe(50);
  });

  it('refuses to nudge a locked layer', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);
    const cx = layer.cx;

    s.toggleLock(layer);
    s.nudge(10, 10);

    expect(layer.cx).toBe(cx);
  });
});

describe('fitCanvas', () => {
  it('does nothing without DOM refs, so the store stays headless', () => {
    const s = store();

    expect(() => s.fitCanvas()).not.toThrow();
    expect(s.canvasScale).toBe(1);
  });

  it('scales into the available area, bounded at both ends', () => {
    const s = store();

    s.attachStage(stageRefs(1000, 800));
    s.fitCanvas();

    expect(s.canvasScale).toBeGreaterThanOrEqual(0.1);
    expect(s.canvasScale).toBeLessThanOrEqual(1.6);
    expect(s.scaleEl?.style.transform).toBe(`scale(${s.canvasScale})`);
  });

  it('refuses a collapsed stage rather than scaling to nothing', () => {
    const s = store();

    s.attachStage(stageRefs(0, 0));
    s.fitCanvas();

    expect(s.canvasScale).toBe(1);
  });

  /*
   * 🔴 The failure this contract exists to prevent. `fitCanvas` needs all three
   * elements and returns early without them, so attaching only the stage leaves
   * canvasScale at 1 — the canvas still LOOKS right, because layers are placed
   * in canvas pixels, but every pointer delta is divided by the wrong number.
   * Only dragging is wrong, and only once the stage is small enough to scale.
   */
  it('does not scale when the wrap and scale elements are missing', () => {
    const s = store();

    s.attachStage({ stage: { clientWidth: 1000, clientHeight: 800 }, wrap: null, scale: null });
    s.fitCanvas();

    expect(s.canvasScale).toBe(1);
  });

  it('releases all three elements on detach, so a unmounted node is not measured', () => {
    const s = store();

    s.attachStage(stageRefs(1000, 800));
    s.attachStage(null);

    expect(s.stageEl).toBeNull();
    expect(s.wrapEl).toBeNull();
    expect(s.scaleEl).toBeNull();
  });
});

/**
 * 🔴 **The two conversion points M26c.2 requires**, and the only way a design
 * leaves or re-enters the editor.
 *
 * *"The editor works in pixels; conversion happens in exactly two functions
 * (export and import) and nowhere else."* Until these existed the store could
 * edit layers and hand them to nothing — a state engine with no boundary.
 */
describe('export and import', () => {
  it('stores geometry as fractions, never pixels', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    layer.cx = 200;
    layer.cy = 230;
    layer.w = 100;
    layer.h = 50;

    const [stored] = s.exportDesign().layers;

    expect(stored.pos.xPct).toBeCloseTo(0.5, 9);
    expect(stored.pos.yPct).toBeCloseTo(0.5, 9);
    expect(stored.pos.wPct).toBeCloseTo(0.25, 9);
  });

  it('omits the background, which the option set owns', () => {
    const s = store();

    s.addLayer('bg.png', 'BG', 400, 460, { kind: 'background' });
    s.addLayer('a.png', 'A', 200, 100);

    const exported = s.exportDesign();

    expect(exported.layers).toHaveLength(1);
    expect(exported.layers[0].name).toBe('A');
  });

  it('round-trips a free layer to the same pixels', () => {
    const s = store();
    const layer = s.addLayer('a.png', 'A', 200, 100);

    layer.cx = 137;
    layer.cy = 211;
    layer.w = 96;
    layer.h = 48;
    layer.style = 'free';

    const back = designLayerToEditor(
      editorLayerToDesign(layer, s.cw, s.ch),
      s.cw,
      s.ch,
      'X',
    );

    expect(back.cx).toBeCloseTo(137, 6);
    expect(back.cy).toBeCloseTo(211, 6);
    expect(back.w).toBeCloseTo(96, 6);
    /* ⚠️ Height is DERIVED from the image aspect, never read back verbatim. */
    expect(back.h).toBeCloseTo(48, 6);
  });

  it('derives a plain layer height from the IMAGE aspect, ignoring stored hPct', () => {
    /*
     * 🔴 **A plain layer is never stretched**, so its height follows the image
     * even when the stored `hPct` disagrees — which legacy rows and hand-edited
     * data both produce.
     *
     * ⚠️ The round trip above could not show this: `hPct` was computed FROM the
     * height, so reading it back gave the same number either way. A mutation
     * reading `hPct` for plain layers passed. Here they deliberately disagree.
     */
    const s = store();

    const layer = designLayerToEditor(
      {
        name: 'A',
        src: 'a.png',
        natW: 200,
        natH: 100,
        /* wPct 0.25 of 400 = 100px wide; a 2:1 image is therefore 50px tall. */
        pos: { xPct: 0.5, yPct: 0.5, wPct: 0.25, hPct: 0.9 },
        rot: 0,
        style: 'free',
        opacity: 100,
        shape: 'none',
        visible: true,
      },
      s.cw,
      s.ch,
      'X',
    );

    expect(layer.w).toBeCloseTo(100, 6);
    /* 50 from the image's 2:1 — not 414 from the stored hPct. */
    expect(layer.h).toBeCloseTo(50, 6);
  });

  it('recomputes a cover layer for the CURRENT canvas, not its stored box', () => {
    /*
     * 🔴 **A cover layer must keep covering after the product photo changes.**
     *
     * ⚠️ The first version of this case exported a cover layer and checked it
     * came back centred — which it did whether or not the style was recomputed,
     * because export had already STORED it centred. A mutation removing the
     * recompute passed. This stores a deliberately WRONG box instead, which only
     * a recompute can correct.
     */
    const loaded = store();

    loaded.importDesign(
      {
        layers: [
          {
            name: 'A',
            src: 'a.png',
            natW: 200,
            natH: 100,
            /* Tiny and off in a corner — nothing a cover layer would ever be. */
            pos: { xPct: 0.1, yPct: 0.1, wPct: 0.05, hPct: 0.05 },
            rot: 0,
            style: 'cover',
            opacity: 100,
            shape: 'none',
            visible: true,
          },
        ],
      },
      null,
    );

    const imported = loaded.layers[0];

    /* Recomputed: centred, and large enough to cover. */
    expect(imported.cx).toBeCloseTo(loaded.cw / 2, 6);
    expect(imported.cy).toBeCloseTo(loaded.ch / 2, 6);
    expect(imported.w).toBeGreaterThanOrEqual(loaded.cw);
  });

  it('adopts the background photo aspect and locks it', () => {
    const s = store();

    s.importDesign(null, { src: 'bg.png', name: 'BG', natW: 200, natH: 100 });

    const bg = s.backgroundLayer();

    expect(bg).not.toBeNull();
    /* 🔴 The product photo is not the merchant's to move. */
    expect(bg!.locked).toBe(true);
    expect(s.ch).toBe(460);
    expect(s.cw).toBe(920);
  });

  it('selects the topmost overlay after loading', () => {
    const s = store();

    s.addLayer('a.png', 'A', 200, 100);
    s.addLayer('b.png', 'B', 200, 100);

    const data = s.exportDesign();
    const loaded = store();

    loaded.importDesign(data, null);

    expect(loaded.getSelected()?.name).toBe('B');
  });

  /**
   * 🔴 **Undo cannot walk backwards through the load itself.**
   *
   * Without suppression, importing would push a snapshot per layer and undo
   * would reach a half-built state the merchant never saw. `suppressHistory`
   * exists for exactly this — and was dead code until `importDesign` was
   * ported, which is what gave it a caller.
   */
  it('leaves exactly one history entry, so undo cannot go behind the load', () => {
    const s = store();

    s.addLayer('a.png', 'A', 200, 100);
    s.addLayer('b.png', 'B', 200, 100);
    s.addLayer('c.png', 'C', 200, 100);

    const data = s.exportDesign();
    const loaded = store();

    loaded.importDesign(data, null);

    expect(loaded.canUndo()).toBe(false);
    expect(loaded.layers).toHaveLength(3);
  });

  it('opens a design saved before opacity, shape and visibility existed', () => {
    const s = store();

    /* ⚠️ A legacy row: only the fields that existed at the time. */
    s.importDesign(
      {
        layers: [
          {
            name: 'old',
            src: 'a.png',
            natW: 200,
            natH: 100,
            pos: { xPct: 0.5, yPct: 0.5, wPct: 0.25, hPct: 0 },
            rot: 0,
            style: 'free',
          } as never,
        ],
      },
      null,
    );

    const layer = s.layers[0];

    expect(layer.opacity).toBe(100);
    expect(layer.shape).toBe('none');
    expect(layer.visible).toBe(true);
  });

  it('replaces whatever was open rather than appending to it', () => {
    const s = store();

    s.addLayer('old.png', 'OLD', 200, 100);
    s.importDesign({ layers: [] }, null);

    expect(s.layers).toHaveLength(0);
    expect(s.selectedId).toBeNull();
  });
});

