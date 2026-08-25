import { z } from 'zod';

import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';
import { pricingConfigSchema } from './pricing.schema';

/**
 * What every option type declares about itself.
 *
 * **The registry is the extension point Phase 14 uses.** Adding `dropdown` or
 * `color_swatch` should be one entry here — a presentation, three schemas, and
 * whether it takes values — not an edit spread across a validator, a serializer
 * and a controller. M7.3 asks for exactly that: build the registry so Phase 14
 * is registration, not refactoring.
 *
 * The three-axis model (M5.4b) is why an entry keys on `presentation` rather than
 * on a flat type name. `radio` and `dropdown` are the same `choice`/`one` pair
 * rendered differently, and `checkbox` is that pair at a different cardinality —
 * so the axes carry the behaviour and the presentation carries the rendering.
 */
export interface OptionTypeDefinition {
  /** How this type renders. The registry key. */
  readonly presentation: Presentation;

  /** What kind of value it produces, and how many. */
  readonly valueKind: ValueKind;
  readonly cardinality: readonly Cardinality[];

  /**
   * Whether the merchant defines a list of values for it.
   *
   * `radio` does; a text field does not. This is what decides whether an option
   * with no values is a mistake or the normal case, which the pre-publish checks
   * in M7.4 need to know.
   */
  readonly takesValues: boolean;

  /** Shape of `options.validation`. */
  readonly validationSchema: z.ZodType;

  /** Shape of `options.display`. */
  readonly displaySchema: z.ZodType;

  /**
   * Shape of `options.pricing` — type-level pricing.
   *
   * Per-value amounts live on `option_values.price_config` and are validated by
   * `pricingConfigSchema` directly, because a value's price does not depend on
   * how the option renders.
   */
  readonly pricingSchema: z.ZodType;
}

/**
 * Validation shared by every choice-based type.
 *
 * `radio`, `dropdown`, `checkbox` and both swatch types differ in rendering and
 * agree on everything else, so their validation is written once. Phase 14
 * registers four presentations against these same schemas rather than copying
 * them.
 */
const choiceValidationSchema = z
  .object({
    /**
     * Whether the merchant must pick something.
     *
     * Duplicated from `options.is_required` deliberately? No — it is **not** here.
     * `is_required` is a column because every type has it; this object holds only
     * what varies by type.
     */
    minSelections: z.number().int().min(0).max(100).optional(),
    maxSelections: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.minSelections !== undefined &&
      value.maxSelections !== undefined &&
      value.minSelections > value.maxSelections
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minSelections'],
        message: `Minimum selections (${value.minSelections}) exceeds the maximum (${value.maxSelections}).`,
      });
    }
  });

/** Display options shared by choice types. */
const choiceDisplaySchema = z
  .object({
    /** Columns in the rendered grid. One means a vertical list. */
    columns: z.number().int().min(1).max(6).optional(),
    /** Where the label sits relative to the control. */
    labelPlacement: z.enum(['above', 'inline', 'hidden']).optional(),
    /** Whether to show the price difference beside each choice. */
    showPriceDelta: z.boolean().optional(),
  })
  .strict();

/**
 * Type-level pricing for a choice type.
 *
 * Always null: a radio's price comes from whichever value is selected, and a
 * type-level amount would be charged in addition to it — silently doubling every
 * priced option. Refusing it outright is clearer than accepting a field nothing
 * reads.
 */
const noTypeLevelPricing = z
  .null()
  .describe('Choice options price per value, not per option.');

/**
 * The registry.
 *
 * `radio` only, per M7.3's scope discipline. Phase 14 adds entries; nothing else
 * in the system needs to change, which is the property this shape exists to
 * provide.
 */
const DEFINITIONS: readonly OptionTypeDefinition[] = [
  {
    presentation: Presentation.RADIO,
    valueKind: ValueKind.CHOICE,
    cardinality: [Cardinality.ONE],
    takesValues: true,
    validationSchema: choiceValidationSchema,
    displaySchema: choiceDisplaySchema,
    pricingSchema: noTypeLevelPricing,
  },
];

const BY_PRESENTATION = new Map<string, OptionTypeDefinition>(
  DEFINITIONS.map((definition) => [definition.presentation, definition]),
);

/** Every registered type. */
export function registeredTypes(): readonly OptionTypeDefinition[] {
  return DEFINITIONS;
}

/**
 * Look up a type, or null if it is not registered.
 *
 * Null rather than a throw: an unregistered presentation is caller input, and
 * the caller turns it into a validation error naming what is supported. A throw
 * here would become a 500 for a typo in a request body.
 */
export function findType(presentation: string): OptionTypeDefinition | null {
  return BY_PRESENTATION.get(presentation) ?? null;
}

/** Whether a presentation has been implemented. */
export function isRegistered(presentation: string): boolean {
  return BY_PRESENTATION.has(presentation);
}

export { pricingConfigSchema };
