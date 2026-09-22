/**
 * How many times an auth route may be called, with a test-only escape.
 *
 * ## Why this exists
 *
 * 🔴 **The E2E suite cannot run twice in an hour without it.** `POST
 * /auth/refresh` is capped at **60 an hour** — correct for production, where a
 * client refreshes every fifteen minutes and sixty is four hours of normal use.
 * A canonical run signs in, navigates, and refreshes repeatedly; several runs
 * exhaust the bucket, and from then on **every navigation lands on "Sign in"**
 * because the access token expires and the exchange answers `429`.
 *
 * ⚠️ **That failure names the wrong thing.** The suite reports an empty-state
 * assertion or a missing site name — whichever screen it reached first — so it
 * reads as a rendering defect. Diagnosed the hard way: three wrong theories
 * (concurrency, a cold PHP process, a stale dev server) before the `429` on
 * `/auth/refresh` was measured directly.
 *
 * ## Why an env variable rather than a lower default
 *
 * 📌 **The production number must not move.** The cap is a brute-force control
 * on the one endpoint that mints access tokens; loosening it to suit a test
 * would trade a real defence for a convenience. `THROTTLE_*` already
 * configures the global buckets in `app.module.ts` — this extends the same
 * contract to the per-route caps, so a test environment raises them explicitly
 * and a deployment that sets nothing keeps the strict behaviour.
 *
 * An unparseable or non-positive value falls back to the default rather than
 * becoming `NaN`, which `@nestjs/throttler` treats as an always-exceeded limit
 * and turns every request into a `429` — the same reasoning `throttleLimit`
 * records.
 */
export function authThrottleLimit(variable: string, fallback: number): number {
  const parsed = Number(process.env[variable]);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
