import type { TextAlign, TextFont, TextVAlign } from '@shared/design/design-geometry.types';

import { MAX_TEXT_CURVE, MIN_TEXT_SIZE, type EditorText } from './text-model';

/**
 * What the properties panel is editing (M26d.3).
 *
 * 🔴 **The three states are exclusive, and that is the store's rule, not this
 * module's.** `select()` clears the text selection and `selectText()` clears
 * the layer's, so the panel shows exactly one subject. Without this the panel
 * would have to guess — and would show a font picker beside a fit mode, acting
 * on two different things.
 */
export type PanelSubject = 'layer' | 'text' | 'none';

export function panelSubject(
  layer: unknown | null,
  text: EditorText | null,
): PanelSubject {
  /*
   * ⚠️ **Text is tested FIRST, and the order is load-bearing.** A store that
   * somehow held both would otherwise show the layer controls while the
   * keyboard moved the text. The store makes that unreachable; this makes it
   * harmless if it ever stops.
   */
  if (text !== null) return 'text';
  if (layer !== null) return 'layer';

  return 'none';
}

/** The slider bounds the text controls offer. */
export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

/**
 * The size slider's range, in canvas pixels.
 *
 * 🔴 **Expressed against the CANVAS, not in fixed pixels.** A design is
 * authored once and rendered at many sizes, so a slider that stopped at 72px
 * would be generous on a 460-tall canvas and useless on a tall product photo.
 * The floor is `MIN_TEXT_SIZE` because that is what `clampText` enforces — a
 * slider that could ask for less would be a control whose bottom end silently
 * did nothing.
 */
export function sizeRange(ch: number): SliderRange {
  return {
    min: MIN_TEXT_SIZE,
    /* Half the canvas height: enough for a headline, short of absurdity. */
    max: Math.max(MIN_TEXT_SIZE * 2, Math.round(ch * 0.5)),
    step: 1,
  };
}

/**
 * The curve slider's range.
 *
 * 🔴 **±`MAX_TEXT_CURVE`, which is the renderer's own bound.** A slider that
 * went further would let the merchant set a value the printed object silently
 * redraws — the disagreement the clamp exists to prevent, reintroduced through
 * the control.
 */
export function curveRange(): SliderRange {
  return { min: -MAX_TEXT_CURVE, max: MAX_TEXT_CURVE, step: 1 };
}

/**
 * The letter-spacing slider's range, in canvas pixels.
 *
 * ⚠️ **Negative is offered deliberately.** Tightening a run is a real
 * typographic choice and the renderer scales it without complaint; a
 * zero-floored slider would remove a capability the geometry already has.
 */
export function letterSpacingRange(ch: number): SliderRange {
  const reach = Math.max(1, Math.round(ch * 0.05));

  return { min: -reach, max: reach, step: 1 };
}

/** The rotation slider's range, in degrees. */
export function rotationRange(): SliderRange {
  return { min: -180, max: 180, step: 1 };
}

/**
 * Whether the box-height control is offering a FIXED height.
 *
 * 🔴 **Zero is auto-grow, a behaviour — not a small height.** The control is a
 * toggle plus a slider rather than a slider alone, because a slider whose
 * bottom end silently changed the mode would be unreadable: the merchant would
 * drag towards "shorter" and get "grows forever" instead.
 */
export function hasFixedHeight(text: EditorText | null): boolean {
  return text !== null && text.h > 0;
}

/**
 * The height to adopt when a merchant turns a fixed box ON.
 *
 * 📌 **A third of the canvas**, not the text's current extent: an auto-growing
 * text has no height of its own to inherit, and reading one back from the DOM
 * would make the control depend on what happened to be rendered.
 */
export function defaultFixedHeight(ch: number): number {
  return Math.max(MIN_TEXT_SIZE, Math.round(ch / 3));
}

/** Every enablement and range the text panel needs, resolved once. */
export interface TextPanelState {
  subject: PanelSubject;
  /** The text being edited, or null when the panel is not showing one. */
  text: EditorText | null;
  fixedHeight: boolean;
  size: SliderRange;
  curve: SliderRange;
  letterSpacing: SliderRange;
  rotation: SliderRange;
  /** 📌 Text opacity is the colour's alpha — see {@link composeColor}. */
  alpha: SliderRange;
}

export function textPanelState(
  layer: unknown | null,
  text: EditorText | null,
  ch: number,
): TextPanelState {
  const subject = panelSubject(layer, text);

  /*
   * 📌 **`text` is used directly, with no second narrowing — a mutation proved
   * the narrowing was dead.** `panelSubject` returns `'text'` for every
   * non-null text, so `subject === 'text' ? text : null` could never evaluate
   * to null while a text was passed. Keeping it would have been an untestable
   * branch that READ like a guard, which is worse than none: a later hand
   * would trust it.
   *
   * ⚠️ **The caller passes the SELECTED text.** `getSelectedText()` returns
   * null unless the text holds the selection, so a layer selection arrives
   * here as `(layer, null)` and this is null too.
   */
  return {
    subject,
    text,
    fixedHeight: hasFixedHeight(text),
    size: sizeRange(ch),
    curve: curveRange(),
    letterSpacing: letterSpacingRange(ch),
    rotation: rotationRange(),
    alpha: alphaRange(),
  };
}

/** The alignment buttons, in reading order. */
export const TEXT_ALIGNS: ReadonlyArray<{ value: TextAlign; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

/** The vertical alignment buttons, in reading order. */
export const TEXT_VALIGNS: ReadonlyArray<{ value: TextVAlign; label: string }> = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
];

/**
 * Whether a font name is one the editor may offer.
 *
 * 🔴 **Guards the SELECT, not just the type.** A `<select>` reports a string;
 * assigning it to `TextFont` with a cast would let a stale option — a family
 * removed from the curated list — through to a design that then renders in a
 * fallback face, or not at all, in a file a customer paid for.
 */
export function isCuratedFont(
  value: string,
  fonts: readonly string[],
): value is TextFont {
  return fonts.includes(value);
}

/**
 * The colour a `<input type="color">` can show, from a stored colour.
 *
 * 🔴 **The stored colour may carry ALPHA; the swatch cannot.** `TextDesign`
 * documents its colour as *"Hex colour, with alpha"*, and the original editor
 * routes text opacity through exactly that — *"opacity is handled via the text
 * color's alpha … no separate slider"*. But `<input type="color">` accepts and
 * reports `#rrggbb` ONLY: handed `#ff000080` it silently falls back to black,
 * so a merchant who set 50% red would reopen their design to find the swatch
 * showing black.
 *
 * ⚠️ **Returns the RGB half, never the alpha**, so the swatch and the slider
 * stay separate controls over one stored value.
 */
export function colorSwatch(stored: string): string {
  const hex = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(stored);

  /* Anything unparseable shows black rather than an empty swatch. */
  return hex ? `#${hex[1]}` : '#000000';
}

/**
 * The alpha a stored colour carries, as a percentage.
 *
 * 📌 **Absent alpha is fully opaque**, which is what a six-digit hex means
 * everywhere else — and what every design saved before this control existed
 * should keep looking like.
 */
export function colorAlphaPercent(stored: string): number {
  const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(stored);

  if (!hex) return 100;

  return Math.round((parseInt(hex[1], 16) / 255) * 100);
}

/**
 * Compose a stored colour from a swatch and an alpha percentage.
 *
 * 🔴 **Fully opaque is written as SIX digits, not `…ff`.** Both render
 * identically, but a design that opened as `#ff0000` and saved itself as
 * `#ff0000ff` would show as modified when nothing was touched — and the
 * round-trip test that proves designs reopen unchanged would be the thing that
 * caught it, after the merchant.
 */
export function composeColor(swatch: string, alphaPercent: number): string {
  const rgb = colorSwatch(swatch);
  const clamped = Math.max(0, Math.min(100, Math.round(alphaPercent)));

  if (clamped >= 100) return rgb;

  const byte = Math.round((clamped / 100) * 255)
    .toString(16)
    .padStart(2, '0');

  return `${rgb}${byte}`;
}

/** The alpha slider's range, as a percentage. */
export function alphaRange(): SliderRange {
  return { min: 0, max: 100, step: 1 };
}
