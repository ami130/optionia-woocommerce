import { StoreStatus } from '../common/database/enums';

/**
 * The connection state machine (M8.1b).
 *
 * ## Why this exists rather than a set of `UPDATE`s
 *
 * M8.1b requires connection state to be "an **explicit, persisted state
 * machine** — not inferred", because ambiguous state is the single largest
 * source of support tickets in this category of product: the merchant sees
 * connected, the cloud disagrees, and nobody can tell which is right.
 *
 * Before this, three scattered `UPDATE stores SET status = …` statements decided
 * state with no notion of what was legal, and `[8g]`, `[8h]` and `[8i]` were each
 * about to add more. Seven ad-hoc writes across four steps is precisely how two
 * sides drift apart.
 *
 * ## The failure that motivated it
 *
 * `[8e]` moved a store to `CONNECTED` with `WHERE id = ?` and no status
 * precondition. That is reachable **without an attacker**:
 *
 * ```text
 * t0     merchant clicks Connect        → code issued, store CONNECTING
 * t0+10s the plugin's exchange fails    → a network blip; it will retry
 * t0+30s merchant clicks Disconnect     → credentials revoked, DISCONNECTED
 * t0+60s the plugin retries with its still-valid code
 *        → the store returns to CONNECTED with a fresh credential,
 *          moments after the merchant disconnected it
 * ```
 *
 * A five-minute code TTL bounds the window; it does not close it. Requiring the
 * store to still be `CONNECTING` does.
 */

/**
 * Which states may precede each state.
 *
 * Read as: *to arrive here, the store must currently be one of these.*
 *
 * `CONNECTING` accepts **every** state deliberately. Re-authorising is always
 * legitimate — a merchant reconnecting a revoked store, retrying a failed
 * connection, or re-linking one that already works — and `[8d]` already relies
 * on it. The guard that matters is not on entering the handshake but on
 * completing it.
 */
const ALLOWED_FROM: Readonly<Record<StoreStatus, readonly StoreStatus[]>> = {
  /** A handshake may begin from anywhere, including `CONNECTED`. */
  [StoreStatus.CONNECTING]: [
    StoreStatus.DISCONNECTED,
    StoreStatus.CONNECTING,
    StoreStatus.CONNECTED,
    StoreStatus.ERROR,
    StoreStatus.REVOKED,
  ],

  /**
   * Only a handshake in progress may complete, and `ERROR` may recover.
   *
   * Excluding `DISCONNECTED` and `REVOKED` is the whole point: a code redeemed
   * after the merchant disconnected must not undo that.
   */
  [StoreStatus.CONNECTED]: [StoreStatus.CONNECTING, StoreStatus.ERROR],

  /** A sync or auth failure, from a store that was working. */
  [StoreStatus.ERROR]: [StoreStatus.CONNECTED, StoreStatus.ERROR],

  /**
   * The merchant's own act, or a handshake that timed out.
   *
   * Self-reachable, like `ERROR` and `REVOKED`. Disconnecting an
   * already-disconnected store is a no-op, not a failure — a merchant
   * double-clicking the button must not see an error for asking twice for a
   * state the store is already in. The contract's response says so: it returns
   * the resulting status rather than a changed/unchanged flag.
   *
   * `CONNECTED` is the deliberate exception. Excluding it from its own
   * predecessors is what refuses a replayed connection code, and that is the
   * whole reason this table exists.
   */
  [StoreStatus.DISCONNECTED]: [
    StoreStatus.CONNECTING,
    StoreStatus.CONNECTED,
    StoreStatus.ERROR,
    StoreStatus.REVOKED,
    StoreStatus.DISCONNECTED,
  ],

  /** The cloud revoking: a site-URL change, or an operator acting. */
  [StoreStatus.REVOKED]: [
    StoreStatus.CONNECTING,
    StoreStatus.CONNECTED,
    StoreStatus.ERROR,
    StoreStatus.REVOKED,
  ],
};

/** Whether the machine permits `from → to`. */
export function canTransition(from: StoreStatus, to: StoreStatus): boolean {
  return ALLOWED_FROM[to]?.includes(from) ?? false;
}

/** The states a store may be in to reach `to`, for a guarded `UPDATE`. */
export function allowedPredecessors(to: StoreStatus): readonly StoreStatus[] {
  return ALLOWED_FROM[to] ?? [];
}

/**
 * Every state, for exhaustiveness checks in tests.
 *
 * Derived from the table rather than written twice: a state added to
 * `StoreStatus` and forgotten here would otherwise be invisible.
 */
export const ALL_STORE_STATUSES = Object.keys(ALLOWED_FROM) as StoreStatus[];
