import { authThrottleLimit } from './auth-throttle';

/**
 * The escape hatch that lets the E2E suite run more than once an hour.
 *
 * 🔴 **The default must stay strict.** These tests exist so that raising a cap
 * for a test environment cannot quietly become the production value — the one
 * failure mode that would turn a brute-force control into a comment.
 */
describe('authThrottleLimit', () => {
  const VARIABLE = 'THROTTLE_TEST_ONLY_LIMIT';

  afterEach(() => {
    delete process.env[VARIABLE];
  });

  it('uses the fallback when nothing is set', () => {
    expect(authThrottleLimit(VARIABLE, 60)).toBe(60);
  });

  it('uses the configured value when one is set', () => {
    process.env[VARIABLE] = '100000';

    expect(authThrottleLimit(VARIABLE, 60)).toBe(100_000);
  });

  /**
   * ⚠️ **A bad value falls back rather than becoming `NaN`.**
   * `@nestjs/throttler` treats `NaN` as an always-exceeded limit, so a typo in
   * a deployment's environment would turn **every** auth request into a `429` —
   * a self-inflicted outage on the one route a locked-out merchant needs.
   */
  it.each(['', 'abc', '0', '-5', 'null'])('falls back for %p', (value) => {
    process.env[VARIABLE] = value;

    expect(authThrottleLimit(VARIABLE, 60)).toBe(60);
  });

  /** A lower value is honoured: the variable tightens as well as loosens. */
  it('honours a value below the fallback', () => {
    process.env[VARIABLE] = '5';

    expect(authThrottleLimit(VARIABLE, 60)).toBe(5);
  });
});
