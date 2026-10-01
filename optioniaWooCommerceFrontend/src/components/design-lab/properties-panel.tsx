'use client';

import { useEffect, useRef } from 'react';

import type { LayerStyle } from '@shared/design/design-geometry.types';
import { panelState } from '@/lib/design-lab/properties-panel';
import type { DesignStore } from '@/lib/design-lab/store';

/**
 * The properties panel: fit mode, alignment, rotation and opacity.
 *
 * 🔴 **Which controls are live is decided in `properties-panel.ts`**, not here.
 * The three predicates look interchangeable and are not — align is refused only
 * for `cover`, rotation needs `free` — and inline in JSX they would be
 * unverifiable in a project with no JSX runner.
 *
 * ⚠️ **The sliders NOTIFY on every input and COMMIT once, after a pause.** The
 * store's `setRotation` and `setOpacity` deliberately do not commit: a slider
 * dragged across its range fires dozens of events, and committing each one would
 * fill the undo stack so that a single undo moves the slider by one step. The
 * debounce below is the other half of that contract, and removing it would not
 * break a test — it would quietly make undo useless.
 */

/** How long a slider rests before its change becomes one undo step. */
const SLIDER_COMMIT_MS = 250;

/** The fit modes, in the order the source offers them. */
const STYLES: ReadonlyArray<{ value: LayerStyle; label: string }> = [
  { value: 'free', label: 'Free' },
  { value: 'fit', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fullw', label: 'Full width' },
  { value: 'fullh', label: 'Full height' },
];

export function PropertiesPanel({ store }: Readonly<{ store: DesignStore }>) {
  const layer = store.getSelected();
  const state = panelState(layer);

  /*
   * One timer for both sliders. They cannot be dragged at once, and a shared
   * timer means releasing one and grabbing the other still commits the first.
   */
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  /* 📌 Restart the clock on each input; the LAST one wins and commits once. */
  function commitSoon() {
    if (commitTimer.current) clearTimeout(commitTimer.current);

    commitTimer.current = setTimeout(() => store.commit(), SLIDER_COMMIT_MS);
  }

  return (
    <div className="optionia-designlab-props">
      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Placement</h3>
        <div className="optionia-designlab-radios">
          {STYLES.map((s) => (
            <label
              key={s.value}
              className={
                'optionia-designlab-radio' +
                (state.style ? '' : ' optionia-designlab-is-disabled')
              }
            >
              <input
                type="radio"
                name="design-lab-style"
                value={s.value}
                disabled={!state.style}
                checked={layer?.style === s.value}
                onChange={() => store.setStyle(s.value)}
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Align</h3>
        <div
          className={
            'optionia-designlab-btn-cluster' +
            (state.align ? '' : ' optionia-designlab-is-disabled')
          }
        >
          {(['left', 'hcenter', 'right'] as const).map((to) => (
            <button
              key={to}
              type="button"
              disabled={!state.align}
              onClick={() => store.alignH(to)}
            >
              {to === 'left' ? 'Left' : to === 'hcenter' ? 'Centre' : 'Right'}
            </button>
          ))}
        </div>
        <div
          className={
            'optionia-designlab-btn-cluster' +
            (state.align ? '' : ' optionia-designlab-is-disabled')
          }
        >
          {(['top', 'vcenter', 'bottom'] as const).map((to) => (
            <button
              key={to}
              type="button"
              disabled={!state.align}
              onClick={() => store.alignV(to)}
            >
              {to === 'top' ? 'Top' : to === 'vcenter' ? 'Middle' : 'Bottom'}
            </button>
          ))}
        </div>
      </section>

      {/*
        ⚠️ Rotation is disabled for every style but `free`, because the others
        recompute the layer's box on each re-fit — the angle would survive in the
        data and be visibly ignored.
      */}
      <section
        className={
          'optionia-designlab-props-section' +
          (state.rotate ? '' : ' optionia-designlab-is-disabled')
        }
      >
        <h3 className="optionia-designlab-props-heading">
          Rotation <span>{Math.round(layer?.rot ?? 0)}°</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={0}
          max={359}
          value={Math.round(layer?.rot ?? 0)}
          disabled={!state.rotate}
          onChange={(e) => {
            store.setRotation(Number(e.target.value));
            commitSoon();
          }}
        />
      </section>

      <section
        className={
          'optionia-designlab-props-section' +
          (state.opacity ? '' : ' optionia-designlab-is-disabled')
        }
      >
        <h3 className="optionia-designlab-props-heading">
          Opacity <span>{Math.round(layer?.opacity ?? 100)}%</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={0}
          max={100}
          value={Math.round(layer?.opacity ?? 100)}
          disabled={!state.opacity}
          onChange={(e) => {
            store.setOpacity(Number(e.target.value));
            commitSoon();
          }}
        />
      </section>
    </div>
  );
}
