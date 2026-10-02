'use client';

import { useState } from 'react';

import {
  backgroundOf,
  canMoveDown,
  canMoveUp,
  listOrder,
  moveInList,
  rowActions,
} from '@/lib/design-lab/layer-list';
import type { EditorLayer } from '@/lib/design-lab/layer.types';
import {
  checkLayerSource,
  layerNameFromUrl,
  layerSourceMessage,
} from '@/lib/design-lab/layer-source';
import type { DesignStore } from '@/lib/design-lab/store';

import { useDesignStore } from './use-design-store';

/**
 * The layer list: what is on the canvas, topmost first.
 *
 * 🔴 **The order is the whole difficulty, and it is decided in `layer-list.ts`.**
 * This list reads top-to-bottom while `store.layers` is paint order, so every id
 * crossing this boundary passes through `listOrder` or `moveInList` rather than
 * being reversed by hand here.
 *
 * ⚠️ **Reordering with buttons, not drag-and-drop.** The source uses a drag grip,
 * which needs pointer capture, an insertion indicator and auto-scroll — none of
 * it decidable outside a browser, and none of it required by M26d.1's text
 * ("add, reorder, lock, hide, duplicate, delete"). Buttons reorder exactly as
 * well and can be verified; a grip can be added later without moving the logic.
 */
export function LayerList({ store }: Readonly<{ store: DesignStore }>) {
  /*
   * ⚠️ Its OWN subscription. Relying on a parent's re-render is what made the
   * first assembly reconcile this list on every pointer move of a canvas drag.
   */
  useDesignStore(store);

  const rows = listOrder(store.layers);
  const background = backgroundOf(store.layers);
  const ids = rows.map((l) => l.id);

  /* `moveInList` returns LIST order, which is what reorderByIds expects. */
  function move(index: number, direction: 'up' | 'down') {
    store.reorderByIds(moveInList(ids, index, direction));
  }

  return (
    <div className="optionia-designlab-side">
      <h3 className="optionia-designlab-side-heading">Layers</h3>

      <AddLayer store={store} />

      {/*
        🔴 **The only way to add or select the text.** Without this the whole
        M26d.3 path is unreachable from the UI — `addText` and `selectText`
        would have no caller, which is the defect this repository has met
        repeatedly and the symbol-reachability gate exists to catch.

        📌 **A row, not a second list.** The text IS part of the design's
        stacking order (the canvas draws it over the layers), so it belongs
        where the merchant already looks for what is in their design.
      */}
      {store.text === null ? (
        <button
          type="button"
          className="optionia-designlab-add-text"
          onClick={() => store.addText()}
        >
          Add text
        </button>
      ) : (
        <button
          type="button"
          className={
            'optionia-designlab-text-row' +
            (store.textSelected ? ' optionia-designlab-is-selected' : '')
          }
          aria-pressed={store.textSelected}
          onClick={() => store.selectText()}
        >
          {/*
            ⚠️ **The sample wording labels the row**, falling back when it is
            empty — an unlabelled row in a list of named layers reads as a bug.
          */}
          <span className="optionia-designlab-text-row-label">
            {store.text.text.trim() || 'Text'}
          </span>
        </button>
      )}

      {rows.length === 0 ? (
        <p className="optionia-designlab-empty">No layers yet.</p>
      ) : (
        <ul className="optionia-designlab-layer-rows">
          {rows.map((layer, index) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              selected={layer.id === store.selectedId}
              canUp={canMoveUp(index)}
              canDown={canMoveDown(index, rows.length)}
              onSelect={() => store.select(layer.id)}
              onUp={() => move(index, 'up')}
              onDown={() => move(index, 'down')}
              onToggleLock={() => store.toggleLock(layer)}
              onToggleVisible={() => store.toggleVisible(layer)}
              onDuplicate={() => store.duplicateLayer(layer)}
              onDelete={() => store.deleteLayer(layer.id)}
            />
          ))}
        </ul>
      )}

      {/*
        📌 The background is rendered apart from the list because it is not a row
        like the others: pinned to the back, never reordered, and replaced rather
        than deleted. Its own controls are M26d.5.
      */}
      {background && (
        <div className="optionia-designlab-bg-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={background.src} alt="" className="optionia-designlab-row-thumb" />
          <span className="optionia-designlab-row-name">{background.name}</span>
          <span className="optionia-designlab-badge">Background</span>
        </div>
      )}
    </div>
  );
}

/**
 * Add a layer from an image URL.
 *
 * 🔴 **M26d.1's first listed capability is "add", and without this nothing can
 * reach `store.addLayer`** — the lab opened onto a canvas a merchant could
 * never put anything on, with every other control operating on layers that
 * could not exist. Found by auditing each store operation for reachability.
 *
 * ⚠️ **A URL box, not the media gallery.** The source reaches `addLayer` from a
 * 764-line MediaGallery, which is M26d.5 (asset library, tenant-scoped uploads,
 * MIME and magic-byte verification). Building it here would pull that milestone
 * forward; a URL is what M26d.1 needs to be true, and the gallery replaces this
 * control rather than being blocked by it.
 *
 * 📌 **The natural size comes from loading the image, and only a browser can
 * give it.** `addLayer` needs `natW`/`natH` to place the layer at a sensible
 * default size — so the URL is validated by a tested function, and the load is
 * the one unavoidable piece of DOM here.
 */
function AddLayer({ store }: Readonly<{ store: DesignStore }>) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function add() {
    const check = checkLayerSource(url);

    if (!check.ok) {
      setError(layerSourceMessage(check.reason!));

      return;
    }

    setError(null);
    setLoading(true);

    const img = new Image();

    /*
     * ⚠️ **Anonymous CORS, deliberately.** A layer drawn onto a canvas from a
     * cross-origin image taints it; requesting anonymously means a server that
     * allows it stays usable and one that does not fails here, visibly, rather
     * than at export time with an empty result.
     */
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      store.addLayer(
        check.url,
        layerNameFromUrl(check.url),
        img.naturalWidth,
        img.naturalHeight,
      );
      setUrl('');
      setLoading(false);
    };

    img.onerror = () => {
      setError('That image could not be loaded. Check the URL is reachable.');
      setLoading(false);
    };

    img.src = check.url;
  }

  return (
    <div className="optionia-designlab-add-layer">
      <input
        type="url"
        value={url}
        placeholder="https://…/artwork.png"
        aria-label="Image URL"
        onChange={(e) => {
          setUrl(e.target.value);
          /* Clear a stale refusal as soon as the merchant edits the box. */
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
      <button type="button" onClick={add} disabled={loading}>
        {loading ? 'Adding…' : 'Add layer'}
      </button>
      {error && (
        <p className="optionia-designlab-add-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function LayerRow({
  layer,
  selected,
  canUp,
  canDown,
  onSelect,
  onUp,
  onDown,
  onToggleLock,
  onToggleVisible,
  onDuplicate,
  onDelete,
}: Readonly<{
  layer: EditorLayer;
  selected: boolean;
  canUp: boolean;
  canDown: boolean;
  onSelect: () => void;
  onUp: () => void;
  onDown: () => void;
  onToggleLock: () => void;
  onToggleVisible: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}>) {
  const actions = rowActions(layer);

  return (
    <li
      className={
        'optionia-designlab-layer-row' +
        (selected ? ' optionia-designlab-row-selected' : '') +
        (layer.visible ? '' : ' optionia-designlab-hidden-layer')
      }
      data-id={layer.id}
    >
      {/*
        ⚠️ A button, not a clickable <li>. The row contains other buttons, and a
        nested interactive element inside a clickable container is both invalid
        and unreachable by keyboard in the order a merchant expects.
      */}
      <button
        type="button"
        className="optionia-designlab-row-select"
        aria-pressed={selected}
        onClick={onSelect}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={layer.src} alt="" className="optionia-designlab-row-thumb" />
        <span className="optionia-designlab-row-name">{layer.name}</span>
        {layer.locked && <span className="optionia-designlab-badge">Locked</span>}
      </button>

      <div className="optionia-designlab-row-actions">
        {actions.reorder && (
          <>
            <button type="button" disabled={!canUp} onClick={onUp} aria-label="Move up">
              ↑
            </button>
            <button
              type="button"
              disabled={!canDown}
              onClick={onDown}
              aria-label="Move down"
            >
              ↓
            </button>
          </>
        )}
        {/*
          🔴 Every action stays live on a LOCKED layer, delete included. The lock
          guards the canvas and is reversible from here; disabling this menu
          would strand the merchant with a layer they can neither move nor
          unlock.
        */}
        {actions.lock && (
          <button
            type="button"
            onClick={onToggleLock}
            aria-label={layer.locked ? 'Unlock' : 'Lock'}
          >
            {layer.locked ? '🔓' : '🔒'}
          </button>
        )}
        {actions.visibility && (
          <button
            type="button"
            onClick={onToggleVisible}
            aria-label={layer.visible ? 'Hide' : 'Show'}
          >
            {layer.visible ? '👁' : '🚫'}
          </button>
        )}
        {actions.duplicate && (
          <button type="button" onClick={onDuplicate} aria-label="Duplicate">
            ⧉
          </button>
        )}
        {actions.remove && (
          <button type="button" onClick={onDelete} aria-label="Delete">
            ✕
          </button>
        )}
      </div>
    </li>
  );
}
