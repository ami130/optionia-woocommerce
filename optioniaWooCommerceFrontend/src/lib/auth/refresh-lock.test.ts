import { describe, expect, it } from 'vitest';

import { REFRESH_LOCK_TTL_MS, refreshIsLocked } from './refresh-lock';

describe('refreshIsLocked', () => {
  /** Nobody has claimed: every context is free to refresh, which is the normal case. */
  it('does not block when no claim exists', () => {
    expect(refreshIsLocked(null, 1_000)).toBe(false);
  });

  /**
   * 🔴 **The defect (F64).** A second context starting its own exchange while
   * the first is in flight presents the same rotated token, and the API revokes
   * the family — signing a merchant out of a working dashboard.
   */
  it('blocks a second context while a claim is fresh', () => {
    expect(refreshIsLocked(1_000, 1_001)).toBe(true);
    expect(refreshIsLocked(1_000, 1_000 + REFRESH_LOCK_TTL_MS - 1)).toBe(true);
  });

  /**
   * 🔴 **The worse failure, and the reason the bound is load-bearing.** A
   * context that dies mid-refresh — closed tab, crash, navigation — leaves its
   * claim behind. Without expiry every later context waits forever and the
   * merchant can never sign in again.
   */
  it('releases a claim left behind by a context that never finished', () => {
    expect(refreshIsLocked(1_000, 1_000 + REFRESH_LOCK_TTL_MS)).toBe(false);
    expect(refreshIsLocked(1_000, 1_000 + REFRESH_LOCK_TTL_MS + 1)).toBe(false);
  });

  /**
   * ⚠️ **A claim from the future is stale, not valid.** A clock that moved
   * backwards would otherwise block every refresh until it caught up. Failing
   * towards "allow" costs one revoked family; failing the other way costs a
   * merchant who cannot sign in at all.
   */
  it('ignores a claim timestamped in the future', () => {
    expect(refreshIsLocked(5_000, 1_000)).toBe(false);
  });

  /** The boundary is exclusive, stated so a later edit cannot drift it silently. */
  it('treats the TTL itself as expired', () => {
    expect(refreshIsLocked(0, REFRESH_LOCK_TTL_MS)).toBe(false);
  });
});
