import { bigintTransformer } from './bigint.transformer';

/**
 * Counters read back from `BIGINT` columns.
 *
 * Four entities depend on this: `option_sets.published_config_version`,
 * `stores.config_version`, `order_selections.config_version` and
 * `usage_records.value`. The first three are what
 * [AC1](../../../../developePlan.md) projects to the plugin — a store whose
 * `config_version` compares wrongly serves stale options to customers. The
 * fourth is what Phase 24 bills against, where a wrong number is a wrong invoice.
 *
 * The failure this prevents is not a crash. MySQL returns `BIGINT` as a string,
 * so without the transformer `configVersion + 1` evaluates to `"421"` rather than
 * `422`, and every comparison downstream is quietly wrong.
 */
describe('bigintTransformer', () => {
  describe('from (database → application)', () => {
    it('parses the driver string into a number', () => {
      expect(bigintTransformer.from('42')).toBe(42);
      expect(typeof bigintTransformer.from('42')).toBe('number');
    });

    /**
     * The whole point. A string counter makes `+ 1` concatenate, which produces
     * a plausible-looking version that is off by orders of magnitude.
     */
    it('returns a value that increments arithmetically', () => {
      const version = bigintTransformer.from('42') as number;

      expect(version + 1).toBe(43);
      expect(version + 1).not.toBe('421');
    });

    it('passes a number through unchanged', () => {
      expect(bigintTransformer.from(7)).toBe(7);
    });

    it('handles zero, which is the column default', () => {
      expect(bigintTransformer.from('0')).toBe(0);
      expect(bigintTransformer.from(0)).toBe(0);
    });

    it('preserves null', () => {
      expect(bigintTransformer.from(null)).toBeNull();
    });

    /**
     * Beyond 2^53 a JavaScript number cannot represent every integer, so the
     * value read back would differ from the value stored. Throwing is the only
     * honest response: returning an approximate counter means a usage record
     * that bills for a quantity nobody recorded.
     */
    it('throws rather than return a value it cannot represent exactly', () => {
      const beyondSafeRange = '9223372036854775807'; // BIGINT max.

      expect(() => bigintTransformer.from(beyondSafeRange)).toThrow(RangeError);
      expect(() => bigintTransformer.from(beyondSafeRange)).toThrow(
        /cannot be represented exactly/,
      );
    });

    it('accepts the largest value it can represent exactly', () => {
      expect(bigintTransformer.from(String(Number.MAX_SAFE_INTEGER))).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it('throws one past the safe range', () => {
      // 2^53, the first integer a double cannot distinguish from its neighbour.
      expect(() => bigintTransformer.from('9007199254740993')).toThrow(RangeError);
    });

    /**
     * A fractional counter means something upstream is treating a discrete count
     * as a measurement. `Number.isSafeInteger` rejects it, and the message names
     * the value so the offending row can be found.
     */
    it('throws on a fractional value', () => {
      expect(() => bigintTransformer.from('1.5')).toThrow(RangeError);
    });

    it('throws on a value that is not a number at all', () => {
      expect(() => bigintTransformer.from('not-a-number')).toThrow(RangeError);
    });

    it('names the offending value so the row can be found', () => {
      expect(() => bigintTransformer.from('1e999')).toThrow(/1e999/);
    });
  });

  describe('to (application → database)', () => {
    it('passes a number through', () => {
      expect(bigintTransformer.to(42)).toBe(42);
      expect(bigintTransformer.to(0)).toBe(0);
    });

    /**
     * `undefined` becomes null rather than reaching the driver, where it would
     * be written as the string "undefined" or rejected depending on the column.
     */
    it('normalises null and undefined to null', () => {
      expect(bigintTransformer.to(null)).toBeNull();
      expect(bigintTransformer.to(undefined)).toBeNull();
    });
  });
});
