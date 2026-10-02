'use client';

import { useEffect, useRef } from 'react';

import type { LayerShape, LayerStyle } from '@shared/design/design-geometry.types';
import { TEXT_FONTS } from '@shared/design/design-geometry.types';
import { panelState } from '@/lib/design-lab/properties-panel';
import {
  TEXT_ALIGNS,
  TEXT_VALIGNS,
  defaultFixedHeight,
  isCuratedFont,
  panelSubject,
  textPanelState,
} from '@/lib/design-lab/text-panel';
import { MIN_TEXT_SIZE, type EditorText } from '@/lib/design-lab/text-model';
import type { DesignStore } from '@/lib/design-lab/store';

import { useDesignStore } from './use-design-store';

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

/**
 * The frames a merchant may pick (M26d.2).
 *
 * ⚠️ **Exactly the keys of `SHAPE_CLIP_PATHS`**, so a frame that can be chosen
 * is always one both the canvas and the server-side renderer can draw. A sixth
 * entry here with no path would clip every layer to nothing.
 *
 * 📌 **`image` is absent**: a custom PNG mask needs uploads, which is M26d.5.
 */
const FRAMES: ReadonlyArray<{ value: LayerShape; label: string }> = [
  { value: 'square', label: 'Square' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'circle', label: 'Circle' },
  { value: 'heart', label: 'Heart' },
  { value: 'star', label: 'Star' },
];

/** The fit modes, in the order the source offers them. */
const STYLES: ReadonlyArray<{ value: LayerStyle; label: string }> = [
  { value: 'free', label: 'Free' },
  { value: 'fit', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fullw', label: 'Full width' },
  { value: 'fullh', label: 'Full height' },
];

export function PropertiesPanel({ store }: Readonly<{ store: DesignStore }>) {
  /* Its own subscription — see `useDesignStore`. */
  useDesignStore(store);

  const layer = store.getSelected();
  const state = panelState(layer);
  const selectedText = store.getSelectedText();

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

  /*
   * 🔴 **One subject at a time, decided in `text-panel.ts`.** A font picker
   * beside a fit mode would be two controls acting on different things — and
   * the store already makes the selections exclusive, so the panel must follow
   * or it would edit whatever happened to be left selected.
   */
  if (panelSubject(layer, selectedText) === 'text' && selectedText) {
    return <TextProperties store={store} text={selectedText} />;
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

      {/*
        🔴 **The frame picker** (M26d.2). Without it `setShapeOn` has no caller
        and the whole frame path is unreachable — the defect this repository has
        met seven times. The shapes are exactly those `SHAPE_CLIP_PATHS`
        defines, so a frame a merchant can pick is always one both renderers
        can draw.

        📌 **A toggle, not a one-way door.** Choosing the current shape clears
        it, which `shapeChangeFor` decides; the button shows that by marking the
        active shape pressed.
      */}
      <section
        className={
          'optionia-designlab-props-section' +
          (state.style ? '' : ' optionia-designlab-is-disabled')
        }
      >
        <h3 className="optionia-designlab-props-heading">Frame</h3>
        <div className="optionia-designlab-shapes">
          {FRAMES.map((frame) => (
            <button
              key={frame.value}
              type="button"
              className={
                'optionia-designlab-shape-btn' +
                (layer?.shape === frame.value ? ' optionia-designlab-shape-on' : '')
              }
              aria-pressed={layer?.shape === frame.value}
              disabled={!state.style || layer === null}
              onClick={() => {
                if (layer) store.setShapeOn(layer, frame.value);
              }}
            >
              {frame.label}
            </button>
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

/**
 * The text controls (M26d.3).
 *
 * 🔴 **Every discrete act COMMITS and every drag only NOTIFIES**, which is the
 * store's contract and not a detail of this file. Typing, picking a font,
 * toggling bold and aligning each commit; the four sliders call `nudgeText` and
 * commit once after a pause. Committing per slider frame would fill all eighty
 * history entries with one drag.
 *
 * ⚠️ **The ranges come from `text-panel.ts`, not from literals here.** The
 * curve slider in particular stops exactly where the RENDERER stops — a wider
 * one would let a merchant set a value the printed object silently redraws.
 */
function TextProperties({
  store,
  text,
}: Readonly<{ store: DesignStore; text: EditorText }>) {
  const state = textPanelState(null, text, store.ch);

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  function commitSoon() {
    if (commitTimer.current) clearTimeout(commitTimer.current);

    commitTimer.current = setTimeout(() => store.commit(), SLIDER_COMMIT_MS);
  }

  /** A slider: notify on every input, commit once when it rests. */
  function drag(patch: Partial<EditorText>) {
    store.nudgeText(patch);
    commitSoon();
  }

  return (
    <div className="optionia-designlab-props">
      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Text</h3>
        {/*
          ⚠️ **The merchant's wording is a SAMPLE.** M26d.3 is explicit that the
          customer's input replaces it when the storefront renders, so the hint
          says so — a merchant who thinks this is the final wording would be
          surprised by their own product page.
        */}
        <textarea
          className="optionia-designlab-textarea"
          value={text.text}
          rows={2}
          onChange={(e) => store.updateText({ text: e.target.value })}
        />
        <p className="optionia-designlab-hint">
          A sample. The customer&rsquo;s own text replaces it on the storefront.
        </p>
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Font</h3>
        <select
          className="optionia-designlab-select"
          value={text.font}
          onChange={(e) => {
            /*
             * 🔴 **Checked, not cast.** A `<select>` reports a string; a cast
             * would let a stale option through to a design that renders in a
             * fallback face in a file a customer paid for.
             */
            if (isCuratedFont(e.target.value, TEXT_FONTS)) {
              store.updateText({ font: e.target.value });
            }
          }}
        >
          {TEXT_FONTS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
        <div className="optionia-designlab-btn-cluster">
          <button
            type="button"
            aria-pressed={text.bold}
            onClick={() => store.updateText({ bold: !text.bold })}
          >
            Bold
          </button>
          <button
            type="button"
            aria-pressed={text.italic}
            onClick={() => store.updateText({ italic: !text.italic })}
          >
            Italic
          </button>
          <label className="optionia-designlab-colour">
            <span>Colour</span>
            <input
              type="color"
              value={text.color}
              onChange={(e) => store.updateText({ color: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">
          Size <span>{Math.round(text.size)}px</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={state.size.min}
          max={state.size.max}
          step={state.size.step}
          value={Math.round(text.size)}
          onChange={(e) => drag({ size: Number(e.target.value) })}
        />
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Alignment</h3>
        <div className="optionia-designlab-btn-cluster">
          {TEXT_ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              aria-pressed={text.align === a.value}
              onClick={() => store.updateText({ align: a.value })}
            >
              {a.label}
            </button>
          ))}
        </div>
        {/*
          📌 **Vertical alignment needs a box to align WITHIN.** With an
          auto-growing text there is no top or bottom — the block simply centres
          — so the control is disabled rather than silently doing nothing.
        */}
        <div
          className={
            'optionia-designlab-btn-cluster' +
            (state.fixedHeight ? '' : ' optionia-designlab-is-disabled')
          }
        >
          {TEXT_VALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              disabled={!state.fixedHeight}
              aria-pressed={text.valign === a.value}
              onClick={() => store.updateText({ valign: a.value })}
            >
              {a.label}
            </button>
          ))}
        </div>
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">Box</h3>
        {/*
          🔴 **A toggle plus a slider, not a slider alone.** Zero height is
          auto-grow — a BEHAVIOUR, not a small box — so a slider whose bottom
          end switched the mode would be unreadable: dragging towards "shorter"
          would produce "grows forever".
        */}
        <label className="optionia-designlab-check">
          <input
            type="checkbox"
            checked={state.fixedHeight}
            onChange={(e) =>
              store.updateText({
                h: e.target.checked ? defaultFixedHeight(store.ch) : 0,
              })
            }
          />
          <span>Fixed height (text shrinks to fit)</span>
        </label>
        {state.fixedHeight ? (
          <input
            type="range"
            className="optionia-designlab-rng"
            min={MIN_TEXT_SIZE}
            max={store.ch}
            value={Math.round(text.h)}
            onChange={(e) => drag({ h: Number(e.target.value) })}
          />
        ) : null}
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">
          Curve <span>{Math.round(text.curve)}</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={state.curve.min}
          max={state.curve.max}
          step={state.curve.step}
          value={Math.round(text.curve)}
          onChange={(e) => drag({ curve: Number(e.target.value) })}
        />
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">
          Letter spacing <span>{Math.round(text.letterSpacing)}px</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={state.letterSpacing.min}
          max={state.letterSpacing.max}
          step={state.letterSpacing.step}
          value={Math.round(text.letterSpacing)}
          onChange={(e) => drag({ letterSpacing: Number(e.target.value) })}
        />
      </section>

      <section className="optionia-designlab-props-section">
        <h3 className="optionia-designlab-props-heading">
          Rotation <span>{Math.round(text.rot)}&deg;</span>
        </h3>
        <input
          type="range"
          className="optionia-designlab-rng"
          min={state.rotation.min}
          max={state.rotation.max}
          step={state.rotation.step}
          value={Math.round(text.rot)}
          onChange={(e) => drag({ rot: Number(e.target.value) })}
        />
      </section>

      <section className="optionia-designlab-props-section">
        <button
          type="button"
          className="optionia-designlab-remove-text"
          onClick={() => store.removeText()}
        >
          Remove text
        </button>
      </section>
    </div>
  );
}
