import { StoreStatus } from '../common/database/enums';
import { ALL_STORE_STATUSES, allowedPredecessors, canTransition } from './store-state';

/**
 * M8.1b's machine, asserted as a table rather than as prose.
 *
 * The diagram in the plan is the specification; these are its edges.
 */
describe('store state machine', () => {
  /**
   * The transition the whole step exists for.
   *
   * A connection code redeemed after the merchant disconnected must not undo
   * that — reachable with no attacker, only a failed exchange the plugin retries
   * and an impatient merchant in between.
   */
  describe('a disconnected store cannot be silently reconnected', () => {
    it('refuses DISCONNECTED → CONNECTED', () => {
      expect(canTransition(StoreStatus.DISCONNECTED, StoreStatus.CONNECTED)).toBe(false);
    });

    it('refuses REVOKED → CONNECTED', () => {
      expect(canTransition(StoreStatus.REVOKED, StoreStatus.CONNECTED)).toBe(false);
    });

    /** The legitimate route back is a fresh handshake, not a stale code. */
    it('allows either to start a new handshake', () => {
      expect(canTransition(StoreStatus.DISCONNECTED, StoreStatus.CONNECTING)).toBe(true);
      expect(canTransition(StoreStatus.REVOKED, StoreStatus.CONNECTING)).toBe(true);
    });
  });

  describe('the edges the plan draws', () => {
    it('allows a handshake to complete', () => {
      expect(canTransition(StoreStatus.CONNECTING, StoreStatus.CONNECTED)).toBe(true);
    });

    it('allows a working store to fail and recover', () => {
      expect(canTransition(StoreStatus.CONNECTED, StoreStatus.ERROR)).toBe(true);
      expect(canTransition(StoreStatus.ERROR, StoreStatus.CONNECTED)).toBe(true);
    });

    it('allows the merchant to disconnect and the cloud to revoke', () => {
      expect(canTransition(StoreStatus.CONNECTED, StoreStatus.DISCONNECTED)).toBe(true);
      expect(canTransition(StoreStatus.CONNECTED, StoreStatus.REVOKED)).toBe(true);
    });

    it('allows a handshake to time out', () => {
      expect(canTransition(StoreStatus.CONNECTING, StoreStatus.DISCONNECTED)).toBe(true);
    });
  });

  /**
   * Re-authorising is always legitimate: reconnecting a revoked store, retrying
   * a failed connection, or re-linking one that already works. `[8d]` relies on
   * this — the guard that matters is on *completing* a handshake, not starting
   * one.
   */
  it('lets a handshake begin from every state', () => {
    ALL_STORE_STATUSES.forEach((from) => {
      expect(canTransition(from, StoreStatus.CONNECTING)).toBe(true);
    });
  });

  /**
   * Every state must be reachable, or it is decoration.
   *
   * A state nothing can enter looks like a modelled possibility and is dead
   * code — the shape of defect this codebase keeps finding.
   */
  it('leaves no state unreachable', () => {
    ALL_STORE_STATUSES.forEach((to) => {
      expect(allowedPredecessors(to).length).toBeGreaterThan(0);
    });
  });

  /** The table must cover the enum, or a new state silently has no rules. */
  it('covers every declared status', () => {
    expect([...ALL_STORE_STATUSES].sort()).toEqual([...Object.values(StoreStatus)].sort());
  });

  /**
   * A floor on strictness. A table that allowed everything would pass every
   * test above while enforcing nothing.
   */
  it('forbids a meaningful share of the possible edges', () => {
    const pairs = ALL_STORE_STATUSES.flatMap((from) =>
      ALL_STORE_STATUSES.map((to) => canTransition(from, to)),
    );
    const refused = pairs.filter((allowed) => !allowed).length;

    expect(refused).toBeGreaterThanOrEqual(2);
  });
});
