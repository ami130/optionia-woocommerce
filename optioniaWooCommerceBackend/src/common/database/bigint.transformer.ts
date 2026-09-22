import type { ValueTransformer } from 'typeorm';

/**
 * Reads a non-money `BIGINT` column as a JavaScript number.
 *
 * MySQL returns `BIGINT` as a string to avoid silent precision loss, so without
 * this a version counter arrives as `"42"` and `configVersion + 1` becomes
 * `"421"`.
 *
 * Distinct from `moneyTransformer`, which additionally rejects fractional values
 * — a fractional counter is meaningless but harmless, while a fractional price
 * means a float leaked into the pricing path.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null => value ?? null,

  from: (value: string | number | null): number | null => {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = typeof value === 'string' ? Number(value) : value;

    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(
        `BIGINT column holds ${String(value)}, which cannot be represented exactly.`,
      );
    }

    return parsed;
  },
};
