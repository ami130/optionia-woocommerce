'use client';

import {
  backgroundOf,
  canMoveDown,
  canMoveUp,
  listOrder,
  moveInList,
  rowActions,
} from '@/lib/design-lab/layer-list';
import type { EditorLayer } from '@/lib/design-lab/layer.types';
import type { DesignStore } from '@/lib/design-lab/store';

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
