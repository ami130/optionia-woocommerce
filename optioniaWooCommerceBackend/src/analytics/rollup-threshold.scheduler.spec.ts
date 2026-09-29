import { RollupThresholdScheduler } from './rollup-threshold.scheduler';
import type { RollupThresholdService } from './rollup-threshold.service';

/**
 * The scheduler's guard, which is the whole reason the flag exists.
 *
 * 🔴 **`@nestjs/schedule` starts its timers when the module loads.** Without a
 * default-off guard, every e2e suite that boots the app would run this monitor
 * against the shared test database, from a process the test neither controls nor
 * waits for. That is not a hypothetical: it is why `BILLING_RETRY_ENABLED`
 * exists, recorded in that scheduler's own docblock.
 */
describe('RollupThresholdScheduler', () => {
  const saved = { ...process.env };

  /*
   * ⚠️ **`loadConfig()` validates the WHOLE environment, not one flag.** A unit
   * test has no `.env`, so the guard under test throws on `JWT_SECRET` long
   * before it reaches the flag — which looks exactly like the guard working.
   * The minimum valid environment is supplied for that reason.
   */
  const baseEnv: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
  };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];

    Object.assign(process.env, baseEnv);
  });

  afterEach(() => {
    jest.restoreAllMocks();

    for (const key of Object.keys(process.env)) delete process.env[key];

    Object.assign(process.env, saved);
  });

  function scheduler(check: jest.Mock) {
    return new RollupThresholdScheduler({ check } as unknown as RollupThresholdService);
  }

  /** 🔴 The default that protects every other suite in the repository. */
  it('does not run when the flag is unset', async () => {
    delete process.env.ANALYTICS_ROLLUP_MONITOR_ENABLED;

    const check = jest.fn();

    await scheduler(check).run();

    expect(check).not.toHaveBeenCalled();
  });

  it('runs when a deployment asks for it', async () => {
    process.env.ANALYTICS_ROLLUP_MONITOR_ENABLED = 'true';

    const check = jest.fn().mockResolvedValue({ approaching: 0, crossed: 0 });

    await scheduler(check).run();

    expect(check).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **A failing check must not take the process down, and must not be
   * silent.** `@nestjs/schedule` logs an unhandled rejection and carries on, so
   * the failure of the thing that exists to give warning would itself go
   * unnoticed — the logged error is the only signal.
   */
  it('survives a failing check and says so', async () => {
    process.env.ANALYTICS_ROLLUP_MONITOR_ENABLED = 'true';

    const check = jest.fn().mockRejectedValue(new Error('database gone'));
    const logged: string[] = [];

    const instance = scheduler(check);

    jest
      .spyOn((instance as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation((message: string) => {
        logged.push(message);
      });

    await expect(instance.run()).resolves.toBeUndefined();

    expect(logged.join(' ')).toContain('database gone');
  });
});
