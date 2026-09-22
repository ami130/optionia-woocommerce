import { z } from 'zod';

import { PresentationalKind } from '../../common/database/enums';

/**
 * What a presentational item's `display` may carry (M21c.5, ADR-113).
 *
 * 🔴 **This existed as `@IsObject()` and nothing else, and that was a hole.**
 * An option's `display` runs through a per-type Zod schema at
 * `option-type.validator.ts`; a presentational item's ran through nothing, so
 * any JSON was accepted, stored and **published to the plugin verbatim**.
 * Measured before this file: a payload carrying
 * `accent_color: '#fff; background: url(//evil)'` and a `<script>` tag
 * validated with **zero errors** and survived to the wire.
 *
 * ⚠️ **It was inert, not safe.** No presentational template read `display`, so
 * nothing reached CSS — and M21c.5 is the milestone that starts reading it. The
 * validation lands in the same cycle as the first field to use it, which is the
 * M21c.4 pattern: the backend rejects a bad value, the plugin refuses to emit
 * one, and neither check makes the other redundant.
 */

/**
 * How a divider is drawn.
 *
 * 🔴 **Three, and `border-style` gives all three for free** (ADR-113).
 * `optionia-app` ships ten, of which three have no CSS equivalent at all — an
 * inline-SVG sine wave as a repeating data URI, a `repeating-linear-gradient`
 * faking a triple rule, and a forced floor for bevels invisible below 3px.
 * Each is a synthesis with its own failure mode.
 *
 * These three are one CSS keyword each on a border the divider already draws:
 * nothing to synthesize, nothing to floor, no data URI to escape.
 */
export const DIVIDER_STYLES = ['solid', 'dashed', 'dotted'] as const;

export type DividerStyle = (typeof DIVIDER_STYLES)[number];

/**
 * A divider's display block.
 *
 * ⚠️ **`.strict()`, so an unknown key is a refusal rather than a silent store.**
 * That is what turns this from documentation into a boundary — and what would
 * have refused the injection payload above.
 */
const dividerDisplaySchema = z
  .object({
    style: z.enum(DIVIDER_STYLES).optional(),
  })
  .strict();

/**
 * Headings and paragraphs carry no display configuration.
 *
 * 📌 **Deliberately empty, not unfinished** (ADR-113). Their rendering is
 * already theme-native — weight and size on a `<p>`, `opacity: 0.85` on copy —
 * and a style list for them would be a control panel nobody asked for. An empty
 * `.strict()` object is the honest spelling: it accepts `{}` and refuses
 * everything else, where omitting the schema would accept anything.
 */
const noDisplaySchema = z.object({}).strict();

/**
 * The schema for one kind's `display`.
 *
 * `rich_text` is unreachable here — the DTO and the service both refuse the kind
 * (M5.4c gates it behind a sanitizer) — so it maps to the empty schema rather
 * than to a schema nobody can exercise.
 */
export function displaySchemaFor(kind: PresentationalKind): z.ZodType {
  return kind === PresentationalKind.DIVIDER ? dividerDisplaySchema : noDisplaySchema;
}
