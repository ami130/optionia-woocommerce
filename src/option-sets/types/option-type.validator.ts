import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DomainException } from '../../common/errors/domain.exception';
import type { ErrorDetail } from '../../common/http/api-response.types';
import { pricingConfigSchema } from './pricing.schema';
import { findType, registeredTypes } from './type-registry';

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

    const details = [
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
 * `null` and `undefined` are skipped rather than validated: all three columns are
 * nullable, and a merchant who has not configured display options has not made a
 * mistake. A schema that genuinely requires a value rejects `null` itself.
 */
function check(field: string, schema: z.ZodType, value: unknown): ErrorDetail[] {
  if (value === undefined) {
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
 */
function codeFor(issue: z.core.$ZodIssue): string {
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
