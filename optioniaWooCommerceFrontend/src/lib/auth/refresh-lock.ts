/**
 * Whether this context may exchange the refresh token, or must wait for another.
 *
 * ## The defect this exists for (F64)
 *
 * 🔴 **Measured in the API log, twice in 95 refreshes**: `refresh token reuse
 * detected … revoked family`, and a merchant on the sign-in screen holding a
 * session they never ended. A `/auth/me` 401s, a refresh succeeds, and two
 * further requests 401 before the new token is stored — their refreshes land
 * **one millisecond apart** presenting the same rotated token.
 *
 * ⚠️ **The server is right to revoke.** `SessionsService.rotate` claims the row
 * atomically and treats a lost claim as reuse, because a concurrent refresh
 * from one client and a stolen token are indistinguishable from there, and
 * theft is the safe reading. Nothing about that should change.
 *
 * ⚠️ **`refreshInFlight` already guards this — within one JS context.** It is a
 * module-level variable, so it is empty after a full page navigation while the
 * refresh token in `localStorage` survives it. Two overlapping contexts, or two
 * tabs, each start their own exchange. The guard's own docblock says it exists
 * to stop exactly this; its scope is what defeats it.
 *
 * ## Why a timestamp and not a mutex
 *
 * 📌 **`localStorage` has no compare-and-swap**, so a true lock cannot be built
 * on it — two contexts can read "free" in the same tick and both write "held".
 * This narrows the window rather than closing it, and says so.
 *
 * 🔴 **A held lock MUST expire**, or a context that dies mid-refresh — a closed
 * tab, a crash, a navigation — leaves every later context waiting forever and
 * the merchant signed out permanently. That is a worse failure than the one
 * being fixed, so the staleness bound is the load-bearing part.
 */

/** How long a claim stays valid before another context may ignore it. */
export const REFRESH_LOCK_TTL_MS = 10_000;

/**
 * Whether a claim recorded at `heldAt` still blocks a refresh now.
 *
 * `null` is "nobody has claimed", which never blocks. A claim from the future —
 * a clock that moved backwards, or another machine's timestamp in a synced
 * store — is treated as **stale rather than valid**, because failing towards
 * "allow the refresh" costs one revoked family and failing the other way costs
 * a merchant who can never sign in again.
 */
export function refreshIsLocked(heldAt: number | null, now: number): boolean {
  if (heldAt === null) {
    return false;
  }

  const age = now - heldAt;

  return age >= 0 && age < REFRESH_LOCK_TTL_MS;
}
