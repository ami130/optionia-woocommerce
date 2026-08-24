import type { ValueTransformer } from 'typeorm';

/**
 * Reads a `BIGINT` money column as a JavaScript integer.
 *
 * MySQL's `BIGINT` can hold values beyond `Number.MAX_SAFE_INTEGER`, so the
 * driver returns it as a **string** to avoid silent precision loss. Without a
 * transformer, `price_amount_minor` arrives as `"1000"` and every comparison,
 * sum and arithmetic operation downstream is subtly wrong — `"1000" + 500`
 * is `"1000500"`.
 *
 * Money is stored as integer minor units ([ADR-013](../../../docs/DECISIONS.md)),
 * so the value is always a whole number of cents, yen or fils.
 */
export const moneyTransformer: ValueTransformer = {
  /** Application → database. Rejects anything that is not a safe integer. */
  to(value: number | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (!Number.isInteger(value)) {
      throw new TypeError(
        `Money must be an integer number of minor units, received ${String(value)}. ` +
          `A fractional value here means a float leaked into the pricing path.`,
      );
    }

    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Money value ${value} exceeds the safe integer range and would lose precision.`,
      );
    }

    return value;
  },

  /** Database → application. */
  from(value: string | number | null): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = typeof value === 'string' ? Number(value) : value;

    if (!Number.isSafeInteger(parsed)) {
      // Reaching here means a stored value exceeds 2^53 — nine quadrillion
      // minor units. That is not a real price; it is corruption or an overflow
      // upstream, and silently truncating it would hide the cause.
      throw new RangeError(
        `Money column holds ${String(value)}, which cannot be represented exactly. ` +
          `This indicates corrupt data rather than a legitimate amount.`,
      );
    }

    return parsed;
  },
};
