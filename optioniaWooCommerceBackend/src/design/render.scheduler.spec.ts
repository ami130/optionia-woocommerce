import { RenderScheduler } from './render.scheduler';
import type { RenderWorkerService } from './render-worker.service';

/**
 * M26e.4's timer, and the guard that keeps it off.
 *
 * 🔴 **This file exists because the worker shipped with no driver at all.** For
 * one commit `renderPending()` had no production caller: a store could request
 * a render, a row was written, and nothing ever rendered it — every job sat at
 * `preparing` for ever. `check-reachable` passed throughout, because
 * registering a provider satisfies *reachable* without anything CALLING it.
 *
 * ⚠️ **`@nestjs/schedule` starts its timers the moment the module loads**, so
 * without a guard every suite that boots the application would rasterise
 * against the shared test database from a process the test neither controls nor
 * waits for.
 */
describe('RenderScheduler', () => {
  const saved = { ...process.env };

  /**
   * 📌 **`loadConfig()` validates the WHOLE environment**, so a partial one
   * fails on `JWT_SECRET` long before it reaches the render flag — the same
   * arrangement the billing scheduler's spec needs.
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
    delete process.env.DESIGN_RENDER_ENABLED;
  });

  afterEach(() => {
    Object.assign(process.env, saved);
  });

  function build(renderPending?: jest.Mock) {
    const pass =
      renderPending ?? jest.fn(async () => ({ claimed: 0, rendered: 0, deadLettered: 0 }));

    return {
      scheduler: new RenderScheduler({
        renderPending: pass,
      } as unknown as RenderWorkerService),
      pass,
    };
  }

  /**
   * 🔴 **Off unless explicitly enabled.** The worker runs in-process, so every
   * instance that has it on drains the same queue — N times the rasterisation
   * for one set of jobs, and rasterising is the expensive thing here.
   */
  it('does nothing unless the flag is set', async () => {
    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **The defect this whole file answers: with the flag set, the pass RUNS.**
   * Nothing asserted that before, because nothing called it.
   */
  it('runs the render pass when the flag is set', async () => {
    process.env.DESIGN_RENDER_ENABLED = 'true';

    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).toHaveBeenCalledTimes(1);
  });

  /**
   * 📌 **`1` and `yes` enable it too**, which is the point of routing through
   * `loadConfig()` rather than comparing a raw string.
   */
  it.each(['1', 'yes'])('accepts %s, as every other boolean flag does', async (spelling) => {
    process.env.DESIGN_RENDER_ENABLED = spelling;

    const { scheduler, pass } = build();

    await scheduler.run();

    expect(pass).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **A typo is LOUD, and loud at BOOT.** `DESIGN_RENDER_ENABLED=maybe`
   * makes `loadConfig()` throw, and `main.ts` calls it at startup — so the
   * application refuses to start rather than running with a worker that
   * silently never fires.
   *
   * ⚠️ **The throw is asserted here, not swallowed.** `run()`'s `try/catch`
   * wraps only the pass: a broken configuration is not a transient failure to
   * log and shrug at.
   */
  it('refuses a value it cannot parse rather than silently disabling', async () => {
    process.env.DESIGN_RENDER_ENABLED = 'maybe';

    const { scheduler, pass } = build();

    await expect(scheduler.run()).rejects.toThrow();
    expect(pass).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **A failing pass must not take the timer down, and must not be
   * silent.** `@nestjs/schedule` logs an unhandled rejection and carries on, so
   * the failure of the thing that produces print files would otherwise go
   * unnoticed until a merchant heard it from a customer.
   */
  it('survives a pass that throws', async () => {
    process.env.DESIGN_RENDER_ENABLED = 'true';

    const { scheduler } = build(
      jest.fn(async () => {
        throw new Error('the rasteriser fell over');
      }),
    );

    await expect(scheduler.run()).resolves.toBeUndefined();
  });
});
