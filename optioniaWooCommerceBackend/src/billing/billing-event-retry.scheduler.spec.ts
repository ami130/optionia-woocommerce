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
  const saved = process.env.BILLING_RETRY_ENABLED;

  afterEach(() => {
    /* 📌 Restored, never deleted (K4): wiping shared state breaks sibling suites. */
    if (saved === undefined) {
      delete process.env.BILLING_RETRY_ENABLED;
    } else {
      process.env.BILLING_RETRY_ENABLED = saved;
    }
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
    delete process.env.BILLING_RETRY_ENABLED;

    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).not.toHaveBeenCalled();
  });

  /** ⚠️ And only the exact string enables it — not "1", not "yes". */
  it('treats any other value as off', async () => {
    process.env.BILLING_RETRY_ENABLED = '1';

    const { scheduler, pass } = build();

    await scheduler.run();

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
