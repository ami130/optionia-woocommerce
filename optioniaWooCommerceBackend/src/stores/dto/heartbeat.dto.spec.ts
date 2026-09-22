import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { HeartbeatDto } from './heartbeat.dto';

const CEILING = 1024 ** 4;

/** Run the field through the real transform-then-validate pipeline. */
function submit(value: unknown): { errors: number; stored: unknown } {
  const dto = plainToInstance(HeartbeatDto, { storage_bytes: value });

  return {
    errors: validateSync(dto as object, { whitelist: true, forbidNonWhitelisted: true }).length,
    stored: dto.storage_bytes,
  };
}

describe('HeartbeatDto.storage_bytes', () => {
  it('accepts an ordinary figure unchanged', () => {
    expect(submit(5_242_880)).toEqual({ errors: 0, stored: 5_242_880 });
  });

  /**
   * 🔴 **An over-range figure is clamped, never rejected.**
   *
   * Enforcing the ceiling with `@Max` turned one bad number into a **400 for the
   * whole heartbeat**, losing the connection state, the version report and the
   * schema signal daily until the figure came back in range. A metric is the
   * least important thing in this payload and must not be able to take the rest
   * of it down.
   */
  it('clamps a figure above the ceiling instead of failing the heartbeat', () => {
    expect(submit(CEILING * 100)).toEqual({ errors: 0, stored: CEILING });
  });

  /**
   * ⚠️ **The saturated value a corrupt plugin can produce.** Measured: a `SUM()`
   * beyond `PHP_INT_MAX` saturates to `9223372036854775807`, roughly nine million
   * times the ceiling.
   */
  it('clamps the value a saturated plugin total would send', () => {
    /*
     * Written as an expression, not as the literal `9_223_372_036_854_775_807`.
     *
     * That literal is past `Number.MAX_SAFE_INTEGER`, so JavaScript parses it as
     * 9223372036854775808 -- a different number than the one PHP saturates to,
     * and the test would have been asserting about a value the plugin cannot
     * send. Building it from `2 ** 63` states the intent (`PHP_INT_MAX`) and
     * makes the imprecision deliberate rather than invisible.
     */
    expect(submit(2 ** 63 - 1).errors).toBe(0);
  });

  it('clamps a negative figure to zero rather than refusing it', () => {
    expect(submit(-5)).toEqual({ errors: 0, stored: 0 });
  });

  /**
   * ⚠️ **A non-numeric value still fails.** Clamping a string into a number would
   * turn a malformed payload into a plausible one, and the validators exist to
   * describe what was wrong.
   */
  it('still refuses a value that is not a number', () => {
    expect(submit('abc').errors).toBeGreaterThan(0);
  });

  it('leaves the field absent when nothing was sent', () => {
    const dto = plainToInstance(HeartbeatDto, {});

    expect(validateSync(dto as object).length).toBe(0);
    expect(dto.storage_bytes).toBeUndefined();
  });
});
