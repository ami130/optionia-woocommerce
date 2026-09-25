import { BillingEventRetryScheduler } from './billing-event-retry.scheduler';
import type { BillingEventRetryService } from './billing-event-retry.service';

/**
 * M23.4's timer, and the guard that keeps it off.
 *
 * 🔴 **`@nestjs/schedule` starts its timers the moment the module loads.**
 * Without a guard, every test suite that boots the application would also start
 * retrying billing events against the shared test database, from a process the
 * test neither controls nor waits for.
 */
describe('BillingEventRetryScheduler', () => {
  const saved = { ...process.env };

  /**
   * 📌 **`loadConfig()` validates the WHOLE environment**, so a partial one
   * fails on `JWT_SECRET` long before it reaches the billing flag — the same
   * arrangement `billing-notifier.service.spec` needs.
   */
  const VALID_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    DB_SSL: 'false',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
    APP_URL: 'https://dash.example.test',
  };

  beforeEach(() => {
    /* 📌 Overlaid, never wiped (K4): emptying process.env breaks sibling suites. */
    Object.assign(process.env, VALID_ENV);
    delete process.env.BILLING_RETRY_ENABLED;
  });

  afterEach(() => {
    Object.assign(process.env, saved);
  });

  function build(retryPending?: jest.Mock) {
    const pass =
      retryPending ?? jest.fn(async () => ({ retried: 0, recovered: 0, deadLettered: 0 }));

    return {
      scheduler: new BillingEventRetryScheduler({
        retryPending: pass,
      } as unknown as BillingEventRetryService),
      pass,
    };
  }

  /**
   * 🔴 **Off unless explicitly enabled.** The worker runs in-process, so every
   * instance that has it on walks the same rows — two instances means one
   * billing event handled twice, concurrently.
   */
  it('does nothing unless the flag is set', async () => {
    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).not.toHaveBeenCalled();
  });

  /**
   * 📌 **`1` and `yes` enable it too, and that is the point of routing through
   * `loadConfig()`.** An earlier version compared the raw string to `'true'`,
   * so this flag alone disagreed with every other boolean in the system.
   */
  it('accepts the same spellings as every other boolean flag', async () => {
    process.env.BILLING_RETRY_ENABLED = '1';

    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **A typo is now LOUD, and it is loud at BOOT.**
   * `BILLING_RETRY_ENABLED=maybe` makes `loadConfig()` throw — and `main.ts`
   * calls it at startup, so the application refuses to start rather than
   * running with a worker that silently never fires. That is the whole point
   * of routing this flag through validation instead of reading `process.env`.
   *
   * ⚠️ **The throw is asserted here, not swallowed.** `run()`'s `try/catch`
   * deliberately wraps only the retry pass: a broken *configuration* is not a
   * transient failure to log and shrug at, and pretending otherwise would
   * restore the silence this change removed.
   */
  it('refuses a value it cannot parse rather than silently disabling', async () => {
    process.env.BILLING_RETRY_ENABLED = 'maybe';

    const { scheduler, pass } = build();

    await expect(scheduler.run()).rejects.toThrow(/must be a boolean/);

    expect(pass).not.toHaveBeenCalled();
  });

  it('runs the pass when enabled', async () => {
    process.env.BILLING_RETRY_ENABLED = 'true';

    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **A scheduled job that throws goes unnoticed.** `@nestjs/schedule` logs
   * an unhandled rejection and carries on, so the failure of the thing that
   * exists to catch failures would itself be silent — and the next tick would
   * be the only hint anything was wrong.
   */
  it('swallows a failed pass rather than rejecting', async () => {
    process.env.BILLING_RETRY_ENABLED = 'true';

    const { scheduler } = build(
      jest.fn(async () => {
        throw new Error('the database went away');
      }),
    );

    await expect(scheduler.run()).resolves.toBeUndefined();
  });
});
