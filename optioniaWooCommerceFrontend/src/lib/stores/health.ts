import type { StoreStatus, StoreSummary } from './api';

/**
 * How long a store may go quiet before it is worth mentioning.
 *
 * 🔴 **The heartbeat is daily**, not hourly: the plugin schedules it with
 * `wp_schedule_event(..., 'daily', ...)`. So **"last seen 20 hours ago" is
 * perfectly healthy**, and a screen highlighting anything older than an hour
 * would report every working store as broken — the fastest way to teach a
 * merchant to ignore this page.
 *
 * Two days rather than one: a single missed run is ordinary on a low-traffic
 * site, where WP-Cron fires only when someone visits. Two misses is a signal.
 */
const STALE_AFTER_MS = 2 * 24 * 60 * 60_000;

export type StoreHealth = 'healthy' | 'stale' | 'never-seen' | 'needs-attention' | 'connecting';

/**
 * What to tell a merchant about one store.
 *
 * Status first, because a `revoked` store that also happens to be stale needs
 * reconnecting rather than investigating — the state machine is the stronger
 * signal, and reporting staleness would send them to look at the wrong thing.
 */
export function storeHealth(store: StoreSummary, now: number = Date.now()): StoreHealth {
  if (store.status === 'error' || store.status === 'revoked' || store.status === 'disconnected') {
    return 'needs-attention';
  }

  if (store.status === 'connecting') {
    return 'connecting';
  }

  if (store.lastSeenAt === null) {
    /*
     * Never checked in. **Not the same as stale**: a store connected an hour ago
     * has not yet run its first daily heartbeat, and calling that a fault would
     * flag every new connection.
     */
    return 'never-seen';
  }

  return now - new Date(store.lastSeenAt).getTime() > STALE_AFTER_MS ? 'stale' : 'healthy';
}

/** What each state means, in words a merchant can act on. */
export function healthLabel(health: StoreHealth, status: StoreStatus): string {
  switch (health) {
    case 'healthy':
      return 'Connected';
    case 'stale':
      return 'Not heard from recently';
    case 'never-seen':
      return 'Connected, awaiting first check-in';
    case 'connecting':
      return 'Finishing setup';
    case 'needs-attention':
      return status === 'revoked'
        ? 'Access revoked — reconnect from WordPress'
        : status === 'disconnected'
          ? 'Disconnected'
          : 'Something went wrong';
  }
}

/** Whether this state should read as a problem rather than as information. */
export function isProblem(health: StoreHealth): boolean {
  return health === 'needs-attention' || health === 'stale';
}
