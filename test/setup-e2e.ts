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
