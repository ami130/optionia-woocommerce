import { describe, expect, it } from 'vitest';

import { TEXT_FONTS } from '@shared/design/design-geometry.types';
import { DesignStore } from './store';
import { MAX_TEXT_CURVE, MIN_TEXT_SIZE, defaultText, type EditorText } from './text-model';
import {
  TEXT_ALIGNS,
  TEXT_VALIGNS,
  curveRange,
  defaultFixedHeight,
  hasFixedHeight,
  isCuratedFont,
  letterSpacingRange,
  panelSubject,
  sizeRange,
  textPanelState,
} from './text-panel';

const CW = 400;
const CH = 460;

function text(over: Partial<EditorText> = {}): EditorText {
  return { ...defaultText(CW, CH), ...over };
}

describe('panelSubject', () => {
  /*
   * 🔴 **Exactly one subject at a time.** Showing both would put a font picker
   * beside a fit mode, each acting on a different thing.
   */
  it('shows the text when a text is selected', () => {
    expect(panelSubject(null, text())).toBe('text');
  });

  it('shows the layer when a layer is selected', () => {
    expect(panelSubject({ id: 'L1' }, null)).toBe('layer');
  });

  it('shows nothing when nothing is selected', () => {
    expect(panelSubject(null, null)).toBe('none');
  });

  /*
   * ⚠️ **The store makes this unreachable; this keeps it harmless.** If both
   * were ever selected, showing the layer would let the panel edit one subject
   * while the keyboard moved the other.
   */
  it('prefers the text if both are somehow selected', () => {
    expect(panelSubject({ id: 'L1' }, text())).toBe('text');
  });
});

describe('the slider ranges', () => {
  /*
   * 🔴 **The curve slider stops where the RENDERER stops.** Going further would
   * let a merchant set a value the printed object silently redraws — the
   * disagreement `clampText` exists to prevent, reintroduced via the control.
   */
  it('bounds the curve at the renderer’s own limit', () => {
    expect(curveRange()).toEqual({ min: -MAX_TEXT_CURVE, max: MAX_TEXT_CURVE, step: 1 });
  });

  /*
   * 🔴 **The size floor is what `clampText` enforces.** A slider that could ask
   * for less would have a bottom end that silently did nothing.
   */
  it('floors the size slider where the clamp does', () => {
    expect(sizeRange(CH).min).toBe(MIN_TEXT_SIZE);
  });

  it('scales the size ceiling with the canvas', () => {
    expect(sizeRange(920).max).toBe(sizeRange(460).max * 2);
  });

  it('keeps the size slider usable on a tiny canvas', () => {
    const range = sizeRange(1);

    expect(range.max).toBeGreaterThan(range.min);
  });

  /*
   * ⚠️ **Negative spacing is offered on purpose** — tightening a run is a real
   * choice the renderer already supports.
   */
  it('offers negative letter spacing', () => {
    expect(letterSpacingRange(CH).min).toBeLessThan(0);
  });

  it('scales letter spacing with the canvas', () => {
    expect(letterSpacingRange(920).max).toBeGreaterThan(letterSpacingRange(460).max);
  });

  it('keeps letter spacing usable on a zero canvas', () => {
    expect(letterSpacingRange(0).max).toBeGreaterThan(0);
  });
});

describe('the fixed-height toggle', () => {
  /*
   * 🔴 **Zero is auto-grow, a BEHAVIOUR — not a small height.** A slider alone
   * would mean dragging towards "shorter" produced "grows forever".
   */
  it('reports auto-grow as not fixed', () => {
    expect(hasFixedHeight(text({ h: 0 }))).toBe(false);
  });

  it('reports a real height as fixed', () => {
    expect(hasFixedHeight(text({ h: 120 }))).toBe(true);
  });

  it('reports no text as not fixed', () => {
    expect(hasFixedHeight(null)).toBe(false);
  });

  it('adopts a usable height when the toggle is turned on', () => {
    expect(defaultFixedHeight(CH)).toBeGreaterThan(MIN_TEXT_SIZE);
  });

  it('never adopts a height below the clamp floor', () => {
    expect(defaultFixedHeight(0)).toBe(MIN_TEXT_SIZE);
  });
});

describe('textPanelState', () => {
  it('carries the text it is showing', () => {
    const t = text({ h: 120 });
    const state = textPanelState(null, t, CH);

    expect(state.subject).toBe('text');
    expect(state.text).toBe(t);
    expect(state.fixedHeight).toBe(true);
  });

  /*
   * ⚠️ **The caller passes the SELECTED text, which is null while a layer
   * holds the selection** — `getSelectedText()` returns null unless the text
   * is the subject. So a layer selection reaches here as `(layer, null)`, and
   * the panel shows no text even though the design has one.
   */
  it('shows no text while a layer is selected', () => {
    const state = textPanelState({ id: 'L1' }, null, CH);

    expect(state.subject).toBe('layer');
    expect(state.text).toBeNull();
  });

  /*
   * 🔴 **The narrowing follows `panelSubject`, not the raw argument.** Both
   * guards must agree on which subject wins or the panel could show a font
   * picker while reporting `subject: 'layer'`. They agree on TEXT — and this
   * case is what proves the narrowing is wired to the decision rather than
   * repeating it.
   */
  it('shows the text when both are passed, agreeing with panelSubject', () => {
    const state = textPanelState({ id: 'L1' }, text(), CH);

    expect(state.subject).toBe('text');
    expect(state.text).not.toBeNull();
  });

  /*
   * ⚠️ **A `none` subject carries no text**, which is the branch that proves
   * `shown` is narrowed at all rather than passed straight through.
   */
  it('carries no text when nothing is selected', () => {
    expect(textPanelState(null, null, CH).text).toBeNull();
  });

  it('resolves ranges even with nothing selected', () => {
    const state = textPanelState(null, null, CH);

    expect(state.subject).toBe('none');
    expect(state.size.max).toBeGreaterThan(state.size.min);
  });
});

describe('the control vocabularies', () => {
  it('offers every horizontal alignment the stored type allows', () => {
    expect(TEXT_ALIGNS.map((a) => a.value)).toEqual(['left', 'center', 'right']);
  });

  it('offers every vertical alignment the stored type allows', () => {
    expect(TEXT_VALIGNS.map((a) => a.value)).toEqual(['top', 'middle', 'bottom']);
  });
});

describe('isCuratedFont', () => {
  /*
   * 🔴 **A `<select>` reports a string.** Casting it to `TextFont` would let a
   * stale option through to a design that renders in a fallback face — or not
   * at all — in a file a customer paid for.
   */
  it('accepts a curated family', () => {
    expect(isCuratedFont('Pacifico', TEXT_FONTS)).toBe(true);
  });

  it('refuses a family that is not curated', () => {
    expect(isCuratedFont('Comic Sans MS', TEXT_FONTS)).toBe(false);
  });

  it('refuses an empty selection', () => {
    expect(isCuratedFont('', TEXT_FONTS)).toBe(false);
  });
});

describe('the ranges against the real store', () => {
  function store(): DesignStore {
    const s = new DesignStore();

    s.cw = CW;
    s.ch = CH;
    s.commit();
    s.addText();

    return s;
  }

  /*
   * 🔴 **Every slider END must survive `clampText`.** A control whose extreme
   * is silently corrected is a control with a dead end — the merchant drags to
   * the stop and the value snaps back, with nothing explaining why. This is the
   * pairing between the panel's ranges and the store's bounds, and neither
   * module can prove it alone.
   */
  it.each([
    ['the size floor', (s: DesignStore) => textPanelState(null, s.text, s.ch).size.min, 'size'],
    ['the size ceiling', (s: DesignStore) => textPanelState(null, s.text, s.ch).size.max, 'size'],
    ['the curve maximum', (s: DesignStore) => textPanelState(null, s.text, s.ch).curve.max, 'curve'],
    ['the curve minimum', (s: DesignStore) => textPanelState(null, s.text, s.ch).curve.min, 'curve'],
    ['the spacing floor', (s: DesignStore) => textPanelState(null, s.text, s.ch).letterSpacing.min, 'letterSpacing'],
    ['the spacing ceiling', (s: DesignStore) => textPanelState(null, s.text, s.ch).letterSpacing.max, 'letterSpacing'],
    ['the rotation minimum', (s: DesignStore) => textPanelState(null, s.text, s.ch).rotation.min, 'rot'],
    ['the rotation maximum', (s: DesignStore) => textPanelState(null, s.text, s.ch).rotation.max, 'rot'],
  ] as const)('%s is reachable', (_name, pick, field) => {
    const s = store();
    const end = pick(s);

    s.nudgeText({ [field]: end });

    expect(s.text?.[field]).toBe(end);
  });

  /*
   * ⚠️ **The height the toggle adopts must survive too**, or switching a text
   * to a fixed box would land on a height the clamp immediately changed.
   */
  it('the height the fixed-box toggle adopts is reachable', () => {
    const s = store();
    const adopted = defaultFixedHeight(s.ch);

    s.updateText({ h: adopted });

    expect(s.text?.h).toBe(adopted);
    expect(hasFixedHeight(s.text)).toBe(true);
  });

  it('turning the fixed box off returns to auto-grow', () => {
    const s = store();

    s.updateText({ h: defaultFixedHeight(s.ch) });
    s.updateText({ h: 0 });

    expect(hasFixedHeight(s.text)).toBe(false);
  });
});
