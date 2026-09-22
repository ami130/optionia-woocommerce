/**
 * The storefront's own view helpers, ported for the preview (M21.1).
 *
 * `OptionView` is the class every option template calls on the storefront, so a
 * preview that renders guidance, display defaults or a price label differently
 * is a preview of something the customer will not see. These read the
 * **published** dialect — `help_text`, `swatch_size`, `price_config` — which is
 * what `previewTree()` produces (ADR-103).
 *
 * 📌 **Ported rather than shared.** The dashboard cannot import from a PHP
 * plugin, so this is a copy in the sense ADR-083 already allows for the
 * evaluators. What holds it honest is `option-view.test.ts`, which asserts the
 * behaviours the plugin's own suite asserts.
 */

/** One block of guidance text, with the id an `aria-describedby` points at. */
export interface GuidanceBlock {
  readonly id: string;
  readonly text: string;
  readonly kind: 'description' | 'help' | 'tooltip';
}

/**
 * An option's guidance, in the order the storefront renders it.
 *
 * ⚠️ **`tooltip` comes from `display`, the other two from the option itself.**
 * That asymmetry is in the storefront and is not an accident: a tooltip is a
 * presentation choice, where a description is content.
 *
 * Whitespace-only text is skipped, not rendered empty — an option with
 * `description: '   '` gets no block and no id, so `aria-describedby` does not
 * point at an empty element.
 */
export function guidance(option: {
  readonly id?: string;
  readonly description?: unknown;
  readonly help_text?: unknown;
  readonly display?: Record<string, unknown> | null;
}): readonly GuidanceBlock[] {
  const id = typeof option.id === 'string' ? option.id : '';

  if (id === '') {
    return [];
  }

  const display = option.display ?? {};

  const fields: readonly [GuidanceBlock['kind'], string, unknown][] = [
    ['description', 'optionia-desc-', option.description],
    ['help', 'optionia-help-', option.help_text],
    ['tooltip', 'optionia-tip-', display.tooltip],
  ];

  return fields.flatMap(([kind, prefix, raw]) => {
    const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';

    return text === '' ? [] : [{ id: `${prefix}${id}`, text, kind }];
  });
}

/** The ids an option's `aria-describedby` lists, or `undefined` when there are none. */
export function describedBy(option: Parameters<typeof guidance>[0]): string | undefined {
  const ids = guidance(option).map((block) => block.id);

  /*
   * `undefined` rather than `''`: React omits the attribute entirely, where an
   * empty string would emit `aria-describedby=""` and point a screen reader at
   * nothing.
   */
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** An option's display settings, with every default the storefront applies. */
export interface DisplaySettings {
  readonly columns: number;
  readonly swatchSize: 'small' | 'medium' | 'large';
  readonly priceDisplay: 'delta' | 'total' | 'hidden';
  readonly collapsed: boolean;
  readonly tooltip: string;
}

const SWATCH_SIZES = ['small', 'medium', 'large'] as const;
const PRICE_DISPLAYS = ['delta', 'total', 'hidden'] as const;

/**
 * Normalise `display`, falling back exactly as the storefront does.
 *
 * 🔴 **Every fallback is the storefront's, not a fresh choice.** `columns`
 * outside 1–6 becomes 1; an unknown `swatch_size` becomes `medium`; an unknown
 * `price_display` becomes `delta`, *"because it is the honest framing: an option
 * adds to a price the customer has already seen."*
 *
 * ⚠️ **A non-integer `columns` falls back too.** The plugin tests `is_int`, so
 * `2.5` is not "2" — it is unconfigured.
 */
export function displaySettings(option: {
  readonly display?: Record<string, unknown> | null;
}): DisplaySettings {
  const config = option.display ?? {};

  const rawColumns = config.columns;
  const columns =
    typeof rawColumns === 'number' &&
    Number.isInteger(rawColumns) &&
    rawColumns >= 1 &&
    rawColumns <= 6
      ? rawColumns
      : 1;

  const size = SWATCH_SIZES.find((candidate) => candidate === config.swatch_size) ?? 'medium';
  const price = PRICE_DISPLAYS.find((candidate) => candidate === config.price_display) ?? 'delta';
  const tooltip = typeof config.tooltip === 'string' ? config.tooltip.trim() : '';

  return {
    columns,
    swatchSize: size,
    priceDisplay: price,
    collapsed: Boolean(config.collapsed_by_default),
    tooltip,
  };
}

/**
 * The four style tokens, as inline custom properties — or `undefined`.
 *
 * 🔴 **The preview's twin of `OptionView::styles()`**, and every rule here is
 * the plugin's rather than a fresh choice (M21c.2, ADR-112). A six-digit hex
 * only; integers inside the authored range; anything else omitted rather than
 * guessed. Phase 21c's exit requires *"configured styles render identically in
 * preview and storefront"*, and two validators disagreeing about one value is
 * exactly how that claim stops being true.
 *
 * ⚠️ **Shorthand hex is refused here too.** `#f00` is valid CSS and a second
 * spelling of a value the authoring layer cannot produce — accepting it would
 * mean the preview draws something the storefront would not.
 *
 * ⚠️ **`undefined`, not `{}`**, when nothing validates: React omits the
 * attribute entirely, where an empty object still emits `style=""` — markup
 * that says a decision was made when none was.
 */
export function styleTokens(option: {
  readonly display?: Record<string, unknown> | null;
}): Record<string, string> | undefined {
  const config = option.display ?? {};
  const out: Record<string, string> = {};

  const accent = config.accent_color;

  if (typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent)) {
    out['--optionia-accent'] = accent;
  }

  /*
   * `Number.isInteger` rather than a numeric coercion: `"4"` is what a form
   * sends when nobody coerced it, and `4.5` reaches a stylesheet as `4.5px`,
   * which renders. The plugin tests `is_int` for the same two reasons.
   */
  const pixels = [
    { key: 'border_radius', name: '--optionia-radius', min: 0, max: 24 },
    { key: 'spacing', name: '--optionia-gap', min: 0, max: 48 },
    { key: 'swatch_px', name: '--optionia-swatch', min: 16, max: 128 },
  ] as const;

  for (const { key, name, min, max } of pixels) {
    const raw = config[key];

    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      continue;
    }

    out[name] = `${raw}px`;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The three divider styles, and the fallback for anything else (M21c.5).
 *
 * 🔴 **The preview's twin of `OptionView::divider_style()`**, allowlist for
 * allowlist. Phase 21c requires *"configured styles render identically in
 * preview and storefront"*, and the preview drew a solid rule whatever the
 * merchant chose until 2026-09-22 (F35) — so a `dashed` divider previewed solid
 * and shipped dashed.
 *
 * ⚠️ **Falls back to `solid`**, exactly as the plugin does, so a stale or
 * hand-edited document degrades the same way on both surfaces.
 */
const DIVIDER_STYLES = ['solid', 'dashed', 'dotted'] as const;

export type DividerStyle = (typeof DIVIDER_STYLES)[number];

export function dividerStyle(item: {
  readonly display?: Record<string, unknown> | null;
}): DividerStyle {
  const style = item.display?.style;

  return DIVIDER_STYLES.find((candidate) => candidate === style) ?? 'solid';
}

/** A value's price as the preview states it. */
export interface ValuePrice {
  /** The formatted delta, signed — `+10.00`, `-5.00` — or `''` when nothing is shown. */
  readonly label: string;
  /**
   * Whether this number needed a base price to compute.
   *
   * A percentage is meaningless without saying what it is a percentage *of*, so
   * a caller that renders one must also state the base (ADR-107).
   */
  readonly needsBase: boolean;
  /** The type that could not be priced at all, or null. */
  readonly unpriced: string | null;
}

/**
 * What to print beside a value.
 *
 * 🔴 **This deliberately shows MORE than the storefront does** (ADR-107).
 * `OptionView::value_price` prints nothing for a `percentage`, because a
 * storefront *"guessing… would show a total the server disagrees with"*. The
 * preview is not guessing: it runs `priceConfigDelta`, the same evaluator the
 * server uses, against a base it states. `frontend.js` asks for exactly this —
 * *"an estimate that knows a variation's base price… is Phase 21's
 * server-quoted preview."*
 *
 * ⚠️ **So a preview and a storefront legitimately differ here**, and that is a
 * recorded fidelity limit rather than a defect. A merchant sees what the
 * customer will be **charged**; the customer's own live estimate shows less.
 *
 * ✅ **Everything else matches the storefront exactly**, and is asserted against
 * its own test cases: `hidden` prints nothing, a zero prints nothing (*"`+0.00`
 * beside a free choice reads as a mistake"*), and `total` renders as `delta`
 * because no template has the base price (ADR-065).
 *
 * @param priceConfig The value's published price config, from `previewTree()`.
 * @param priceDisplay The option's normalised `price_display`.
 * @param baseMinor The product's base price, for percentages.
 * @param format How this build writes money.
 */
export function valuePrice(
  priceConfig: Record<string, unknown> | null | undefined,
  priceDisplay: DisplaySettings['priceDisplay'],
  baseMinor: number,
  format: (minor: number) => string,
  delta: (config: Record<string, unknown> | null | undefined, base: number) =>
    { deltaMinor: number; unpriced: string | null },
): ValuePrice {
  if (priceDisplay === 'hidden') {
    return { label: '', needsBase: false, unpriced: null };
  }

  const priced = delta(priceConfig, baseMinor);

  if (priced.unpriced !== null) {
    return { label: '', needsBase: false, unpriced: priced.unpriced };
  }

  /*
   * A zero prints nothing — the same choice `CartDisplay::with_price()` records
   * for a cart line. `+0.00` beside a free choice reads as a mistake.
   */
  if (priced.deltaMinor === 0) {
    return { label: '', needsBase: false, unpriced: null };
  }

  const type = typeof priceConfig?.type === 'string' ? priceConfig.type : '';
  const sign = priced.deltaMinor > 0 ? '+' : '-';

  return {
    label: `${sign}${format(Math.abs(priced.deltaMinor))}`,
    needsBase: type === 'percentage',
    unpriced: null,
  };
}

/**
 * The narrowest a choice column may be before the grid drops one.
 *
 * 🔴 **Shared with the plugin's stylesheet, where it is written once**:
 * `grid-template-columns: repeat(auto-fit, minmax(7em, 1fr))`. The two drifting
 * apart would mean a preview that wraps at a different width from the shop, so
 * `bin/check-display-settings.sh` asserts this value against
 * `assets/css/frontend.css` rather than trusting the copy.
 */
export const CHOICE_COLUMN_MIN = '7em';

/**
 * A swatch's size in `em`, matching the storefront's three.
 *
 * `medium` is the base rule (`2em`); `small` and `large` override it. Written
 * out rather than derived, because the storefront writes them out.
 */
export const SWATCH_SIZES_EM: Readonly<Record<DisplaySettings['swatchSize'], string>> = {
  small: '1.5em',
  medium: '2em',
  large: '3em',
};
