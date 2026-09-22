import { moneyTransformer } from './money.transformer';

/**
 * MySQL returns `BIGINT` as a string to avoid silent precision loss. Without
 * this transformer `price_amount_minor` arrives as `"1000"`, and every
 * comparison and sum downstream is subtly wrong — `"1000" + 500` is
 * `"1000500"`.
 */
describe('moneyTransformer', () => {
  describe('from (database → application)', () => {
    it('parses the driver string into a number', () => {
      expect(moneyTransformer.from('1000')).toBe(1000);
      expect(typeof moneyTransformer.from('1000')).toBe('number');
    });

    it('passes a number through', () => {
      expect(moneyTransformer.from(2500)).toBe(2500);
    });

    it('handles zero and negatives', () => {
      // Negative amounts are legitimate: an option can reduce the price.
      expect(moneyTransformer.from('0')).toBe(0);
      expect(moneyTransformer.from('-250')).toBe(-250);
    });

    it('preserves null', () => {
      expect(moneyTransformer.from(null)).toBeNull();
    });

    /**
     * Beyond 2^53 a stored value cannot be represented exactly. That is nine
     * quadrillion minor units — not a real price, so it means corruption or an
     * overflow upstream. Truncating silently would hide the cause.
     */
    it('throws rather than truncating an unrepresentable value', () => {
      expect(() => moneyTransformer.from('9007199254740993')).toThrow(RangeError);
    });
  });

  describe('to (application → database)', () => {
    it('passes an integer through', () => {
      expect(moneyTransformer.to(1999)).toBe(1999);
    });

    it('preserves null and undefined', () => {
      expect(moneyTransformer.to(null)).toBeNull();
      expect(moneyTransformer.to(undefined)).toBeNull();
    });

    /**
     * The guard that matters. A fractional value here means a float leaked into
     * the pricing path — the exact failure Support\Money and the integer-minor-
     * unit convention exist to prevent.
     */
    it('rejects a fractional value', () => {
      expect(() => moneyTransformer.to(19.99)).toThrow(TypeError);
      expect(() => moneyTransformer.to(19.99)).toThrow(/integer number of minor units/);
    });

    it('rejects a value beyond the safe integer range', () => {
      expect(() => moneyTransformer.to(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    });

    it('accepts the safe integer boundary', () => {
      expect(moneyTransformer.to(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it('round-trips through the driver representation', () => {
    for (const amount of [0, 1, 1999, -250, 100000000]) {
      const stored = moneyTransformer.to(amount);
      expect(moneyTransformer.from(String(stored))).toBe(amount);
    }
  });
});
