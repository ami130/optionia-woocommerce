import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DomainException } from '../../common/errors/domain.exception';
import type { ErrorDetail } from '../../common/http/api-response.types';
import { pricingConfigSchema } from './pricing.schema';
import { findType, registeredTypes, type OptionTypeDefinition } from './type-registry';

/**
 * Validates an option's type-specific JSON at the API boundary.
 *
 * **MySQL checks JSON syntax, not shape.** `{"type":"fixed","amountMinor":"ten"}`
 * is valid JSON and a broken price, and it stays broken until a customer reaches
 * checkout — so the boundary is the last place it can be caught cheaply.
 *
 * Every failure names the field that caused it. A merchant told "pricing is
 * invalid" has to guess; one told `pricing.amountMinor must be a whole number of
 * minor units` does not.
 */
@Injectable()
export class OptionTypeValidator {
  /**
   * Validate an option's `validation`, `pricing` and `display` for its type.
   *
   * All three are checked before throwing, so a merchant fixing a form sees
   * every problem at once rather than one per submission.
   */
  assertValidOption(
    presentation: string,
    payload: {
      valueKind?: unknown;
      cardinality?: unknown;
      validation?: unknown;
      pricing?: unknown;
      display?: unknown;
    },
  ): void {
    const definition = findType(presentation);

    if (!definition) {
      const supported = registeredTypes()
        .map((type) => type.presentation)
        .join(', ');

      throw DomainException.validation([
        {
          field: 'presentation',
          code: 'UNSUPPORTED_OPTION_TYPE',
          params: {
            message: `Option type "${presentation}" is not available. Supported: ${supported}.`,
            supported,
          },
        },
      ]);
    }

    /**
     * The three axes must agree with the type's declaration.
     *
     * The registry says `radio` is `choice`/`one`. Nothing in the schema stops a
     * row being written as `radio`/`text`/`many`, and no renderer, validator or
     * pricing path can do anything sensible with it — the axes are what carry the
     * behaviour (M5.4b), so an incoherent triple is an option that exists and
     * cannot work.
     *
     * Checked here rather than by a database constraint because the valid
     * combinations come from the registry, and Phase 14 adds combinations by
     * adding entries rather than by altering a table.
     */
    const axisDetails: ErrorDetail[] = [];

    if (payload.valueKind !== undefined && payload.valueKind !== definition.valueKind) {
      axisDetails.push({
        field: 'valueKind',
        code: 'INCOMPATIBLE_AXIS',
        params: {
          message:
            `Option type "${presentation}" produces ${definition.valueKind} values, ` +
            `not ${String(payload.valueKind)}.`,
        },
      });
    }

    if (
      payload.cardinality !== undefined &&
      !definition.cardinality.includes(payload.cardinality as never)
    ) {
      axisDetails.push({
        field: 'cardinality',
        code: 'INCOMPATIBLE_AXIS',
        params: {
          message:
            `Option type "${presentation}" supports ${definition.cardinality.join(' or ')}, ` +
            `not ${String(payload.cardinality)}.`,
        },
      });
    }

    const details = [
      ...axisDetails,
      ...check('validation', definition.validationSchema, payload.validation),
      ...check('pricing', definition.pricingSchema, payload.pricing),
      ...check('display', definition.displaySchema, payload.display),
    ];

    if (details.length > 0) {
      throw DomainException.validation(details);
    }
  }

  /**
   * Validate a value's `price_config`.
   *
   * Separate from the option's type because a value's price does not depend on
   * how the option renders — a radio and a dropdown price identically.
   */
  /**
   * A stored config with any key its schema no longer recognises removed.
   *
   * 🔴 **A withdrawn field would otherwise make an option permanently
   * uneditable.** `OptionsService.update()` re-validates the **stored**
   * `validation`, `pricing` and `display` — correctly, because a partial patch
   * can produce a combination that is invalid even though each field looked
   * fine alone. But the display schemas are `.strict()`, so a row holding a key
   * that has since been withdrawn fails with `unrecognized_keys`, and the
   * merchant cannot change the label, the price, or anything else. They cannot
   * even clear the offending field, because clearing it requires an update.
   *
   * Measured with a stored `{ columns: 3, labelPlacement: 'above' }` after
   * M18.6a withdrew `labelPlacement` (ADR-064): `parses? false`.
   *
   * ⚠️ **ADR-056 is where this obligation comes from.** It withdrew the `show`
   * rule action and reasoned about stored rows explicitly — *"a stored `show`
   * row degrades to a rule that does nothing… no migration, and no behaviour
   * change for any existing store"* — because every evaluator **ignores** an
   * action it does not know. `.strict()` does the opposite: it **rejects**. So
   * a config withdrawal needs this to degrade the same way an action
   * withdrawal already does.
   *
   * 🔴 **Zod names the keys, so this cannot drift from the schema.** A
   * hand-maintained allow-list would be a second statement of what the schema
   * accepts, and the one that gets forgotten — the shape `bin/check-wire-keys.sh`
   * exists to catch elsewhere.
   *
   * ⚠️ **Applied on the way IN to validation, never on the way in from a
   * request.** A merchant submitting an unknown key still gets an error:
   * `assertValidOption` is unchanged, and only a value already in the database
   * is forgiven. Silently accepting a typo on create is how a field comes to be
   * stored and read by nothing.
   *
   * @param schema The schema the stored value is checked against.
   * @param stored The value as the database holds it.
   * @returns The value with unrecognised keys removed, or it unchanged.
   */
  stripWithdrawn(schema: z.ZodType, stored: unknown): unknown {
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return stored;
    }

    const result = schema.safeParse(stored);

    if (result.success) {
      return stored;
    }

    const withdrawn = new Set(
      result.error.issues
        .filter((issue) => issue.code === 'unrecognized_keys')
        .flatMap((issue) => (issue as unknown as { keys?: string[] }).keys ?? []),
    );

    if (withdrawn.size === 0) {
      /*
       * A different failure — a bound broken, a wrong type. Returned unchanged
       * so `assertValidOption` reports it: this method forgives a key that no
       * longer exists, not a value that was always wrong.
       */
      return stored;
    }

    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).filter(([key]) => !withdrawn.has(key)),
    );
  }

  /**
   * The registry entry for a type, after `assertValidOption` has accepted it.
   *
   * Callers need the declared axes to fill in what a request omitted — `radio`
   * *is* `choice`/`one`, and a caller that does not say so must still store a
   * row the evaluator can interpret. Throwing on an unknown type keeps that
   * defaulting from silently inventing one.
   */
  describe(presentation: string): OptionTypeDefinition {
    const definition = findType(presentation);

    if (!definition) {
      throw DomainException.validation([
        { field: 'presentation', code: 'UNSUPPORTED_OPTION_TYPE' },
      ]);
    }

    return definition;
  }

  assertValidValuePricing(priceConfig: unknown, valueIndex?: number): void {
    const prefix = valueIndex === undefined ? 'priceConfig' : `values.${valueIndex}.priceConfig`;
    const details = check(prefix, pricingConfigSchema, priceConfig);

    if (details.length > 0) {
      throw DomainException.validation(details);
    }
  }
}

/**
 * Run one schema and translate its failures.
 *
 * **`null` means "not configured" and is skipped, not validated.** All three
 * columns are nullable, MySQL returns `null` rather than `undefined`, and a
 * merchant who has never opened the display panel has not made a mistake.
 *
 * The first version skipped only `undefined`, which is what a hand-written test
 * object contains and what a database row never does — every one of the 45
 * seeded options failed validation on `validation: null`, and no unit test
 * noticed because none of them read a real row.
 *
 * A schema that genuinely requires a value expresses that by rejecting an empty
 * object, not by relying on this.
 */
function check(field: string, schema: z.ZodType, value: unknown): ErrorDetail[] {
  if (value === undefined || value === null) {
    return [];
  }

  const result = schema.safeParse(value);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => ({
    // Zod's path is relative to the object being parsed; prefixing it gives the
    // dotted path the API contract promises, e.g. `pricing.tiers.2.minQuantity`.
    field: [field, ...issue.path.map(String)].join('.'),
    code: codeFor(issue),
    params: { message: issue.message },
  }));
}

/**
 * A stable, machine-readable code for a Zod issue.
 *
 * The message is for a person and may be reworded; the code is what a dashboard
 * branches on, so it is derived from the issue kind rather than the text.
 *
 * ⚠️ **Exported since M17.1's CRUD.** Rules validate `conditions` against their
 * own Zod schema and must produce the same codes a dashboard already branches
 * on — a second mapping would answer `INVALID_VARIANT` here and `INVALID_UNION`
 * there for one kind of mistake.
 */
export function codeFor(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'INVALID_TYPE';
    case 'too_small':
      return 'TOO_SMALL';
    case 'too_big':
      return 'TOO_BIG';
    case 'invalid_value':
      return 'INVALID_VALUE';
    case 'unrecognized_keys':
      return 'UNKNOWN_FIELD';
    case 'invalid_union':
      return 'INVALID_VARIANT';
    default:
      return 'INVALID';
  }
}
