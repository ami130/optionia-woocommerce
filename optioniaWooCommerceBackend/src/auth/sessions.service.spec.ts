import { parseDuration } from './sessions.service';

/**
 * Duration parsing.
 *
 * The refresh TTL arrives as a string like `30d`. `parseInt` gives 30 for that,
 * which is correct only because the unit happens to be days — `720h` would give
 * 720, and treating it as days turns a two-week tightening into a two-year token.
 * That is a silent, enormous change from a value that reads as a reduction.
 */
describe('parseDuration', () => {
  const FALLBACK = 999;

  it('reads each supported unit', () => {
    expect(parseDuration('45s', FALLBACK)).toBe(45_000);
    expect(parseDuration('15m', FALLBACK)).toBe(900_000);
    expect(parseDuration('12h', FALLBACK)).toBe(43_200_000);
    expect(parseDuration('30d', FALLBACK)).toBe(30 * 86_400_000);
  });

  /** The bug this exists to prevent. */
  it('does not treat hours as days', () => {
    expect(parseDuration('720h', FALLBACK)).toBe(30 * 86_400_000);
    expect(parseDuration('720h', FALLBACK)).not.toBe(720 * 86_400_000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration('  7d ', FALLBACK)).toBe(7 * 86_400_000);
  });

  /**
   * A malformed value falls back rather than throwing. A session TTL that fails
   * to parse must not stop the application booting — the safe default is a
   * shorter, known duration.
   */
  it('falls back on anything it cannot parse', () => {
    expect(parseDuration('', FALLBACK)).toBe(FALLBACK);
    expect(parseDuration('forever', FALLBACK)).toBe(FALLBACK);
    expect(parseDuration('30', FALLBACK)).toBe(FALLBACK);
    expect(parseDuration('30w', FALLBACK)).toBe(FALLBACK);
    expect(parseDuration('-5d', FALLBACK)).toBe(FALLBACK);
  });

  /** Zero would mint a token that has already expired. */
  it('falls back on zero', () => {
    expect(parseDuration('0d', FALLBACK)).toBe(FALLBACK);
  });
});
