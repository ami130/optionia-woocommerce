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
process.env.THROTTLE_SHORT_LIMIT ??= '100000';
process.env.THROTTLE_DEFAULT_LIMIT ??= '100000';
process.env.THROTTLE_SUSTAINED_LIMIT ??= '100000';


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
