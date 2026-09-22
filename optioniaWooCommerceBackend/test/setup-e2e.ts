import { config as loadDotenv } from 'dotenv';

/**
 * Environment for the e2e run, applied before any suite imports `AppModule`.
 *
 * **Rate limits are raised, not removed.** The `short` bucket allows 20
 * requests per second from one IP — a figure a real user never approaches and
 * a test suite exceeds in a single `describe`. Every suite runs from
 * `::ffff:127.0.0.1`, so they share one bucket and the run trips a limit that
 * production traffic would not.
 *
 * The guard still runs and still keys per IP; only the ceiling moves. The
 * throttler's own tests assert that it refuses when a limit *is* reached, and
 * those set their own limits rather than relying on these.
 *
 * Set before `loadDotenv()` runs in each suite: `dotenv` does not overwrite an
 * existing variable, so anything defined here wins over `.env` and a developer
 * can still override it from their shell.
 */
/**
 * 🔴 **The e2e run gets its own database, or it gets the developer's.**
 *
 * Nothing pinned `DB_NAME`, so the suite used whatever `.env` said — and a
 * developer `.env` points at the development database. Measured 2026-09-22: a
 * local run against `optionia_woo_dev` created tenants in it (36 → 39) and
 * **34 of 1038 tests failed** on state a clean database does not have, while
 * the identical commit passed 1038/1038 on CI, which sets `DB_NAME` itself.
 *
 * ⚠️ **The teardown is what makes this more than untidy.** It runs
 * `DELETE FROM tenants` for every tenant with no members, option sets or
 * stores — correct against a test database, and a sweep of real rows against a
 * development one. Only `demo-merchant` is exempt.
 *
 * `??=` so a deliberate override still wins: CI sets `DB_NAME` in the job env,
 * and that value is left alone.
 */
process.env.DB_NAME ??= 'optionia_woo_test';
process.env.NODE_ENV ??= 'test';

process.env.THROTTLE_SHORT_LIMIT ??= '100000';
process.env.THROTTLE_DEFAULT_LIMIT ??= '100000';
process.env.THROTTLE_SUSTAINED_LIMIT ??= '100000';

/*
 * ⚠️ **The per-route auth caps are separate, and raising the globals misses
 * them.** `POST /auth/refresh` allows 60 an hour in the controller; a suite
 * that signs in and navigates repeatedly exhausts it, and every later
 * navigation lands on the sign-in screen instead of the page under test.
 */
process.env.THROTTLE_REFRESH_LIMIT ??= '100000';


/**
 * Load `.env` here, before any suite's imports are evaluated.
 *
 * Suites have historically called `loadDotenv()` as the first line of
 * `beforeAll`, which is late: a suite that declares a test-only `@Module` at file
 * scope has its decorators evaluated at **import** time, and anything reading
 * configuration then — `JwtModule.registerAsync`, for one — throws
 * `Missing required environment variable` before `beforeAll` ever runs.
 *
 * `tenant-isolation` hit exactly that when it moved to the shared bootstrap. The
 * per-suite call is not wrong, just too late to be relied on, and `dotenv` does
 * not overwrite an existing variable — so loading here is idempotent and every
 * later `loadDotenv()` becomes a no-op rather than a conflict.
 */
loadDotenv();
