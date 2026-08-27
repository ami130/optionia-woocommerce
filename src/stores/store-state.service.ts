import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { StoreStatus } from '../common/database/enums';
import { allowedPredecessors } from './store-state';

/**
 * Whether the store moved.
 *
 * A bare boolean, deliberately. An earlier version also returned the state the
 * store was found in — which cost a `SELECT` on every refusal and **no caller
 * ever read**. The same defect as the `tenantId` and `reason` parameters removed
 * alongside it: a field that looks maintained, is not read, and charges a round
 * trip on the failure path.
 *
 * If a caller ever needs the current state to explain a refusal, it can read it
 * once and say so, rather than every caller paying for it always.
 */
export type TransitionResult = boolean;

/**
 * Performs connection-state transitions, and refuses the ones M8.1b forbids.
 *
 * Every `stores.status` write goes through here. `bin/check-store-state.sh`
 * enforces that: naming a `StoreStatus` value anywhere else fails the build,
 * because a convention that is merely documented is one the next step forgets.
 *
 * ## It does not audit, deliberately
 *
 * An earlier version carried a `record()` that derived the audit action from the
 * destination state. It had **no callers**, and the reason it never acquired any
 * is that the mapping cannot work: `[8d]` distinguishes a fresh connection from a
 * reconnection, and both arrive at `CONNECTING`. Any caller using it would have
 * logged every reconnect as a first-time connect.
 *
 * Audit entries therefore stay at the call site, which is the only place that
 * knows what the transition *meant*. That also keeps them after the transaction
 * commits — an entry written inside one that later rolls back survives it and
 * reports a change that never happened.
 */
@Injectable()
export class StoreStateService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Move a store to `to`, but only from a state the machine allows.
   *
   * **A conditional write, not a read then a write.** The predecessor set goes
   * into the `WHERE`, so a store that changed state between the check and the
   * write is refused by the database rather than by a stale read — the same
   * reason `authorize` and `exchange` claim their rows this way.
   *
   * Returns `moved: false` instead of throwing: the callers differ on what an
   * illegal transition means. A replayed connection code is a `TOKEN_INVALID`
   * refusal; a heartbeat reporting failure on an already-disconnected store is
   * simply nothing to do.
   *
   * `manager` is optional so a caller can enlist this in its own transaction —
   * `[8e]` must spend the code, mint the credential and connect the store
   * atomically, and a separate connection here would break that.
   */
  async transition(
    storeId: string,
    to: StoreStatus,
    options: { manager?: EntityManager } = {},
  ): Promise<TransitionResult> {
    const runner = options.manager ?? this.dataSource;
    const from = allowedPredecessors(to);

    if (from.length === 0) {
      return false;
    }

    const placeholders = from.map(() => '?').join(', ');

    /**
     * `connectedAt` is stamped on arrival at `CONNECTED` and never cleared.
     *
     * The column existed from the initial schema and nothing wrote it — support
     * asks "connected since when?" and the answer was null for every store. It
     * records the *most recent* connection, which is the question actually
     * asked; the full history is in `audit_logs`.
     */
    const stamp = to === StoreStatus.CONNECTED ? ', connectedAt = NOW(3)' : '';

    const result = await runner.query(
      `UPDATE stores SET status = ?, updatedAt = NOW(3)${stamp}
        WHERE id = ? AND status IN (${placeholders})`,
      [to, storeId, ...from],
    );

    // Either the store is gone or it was not in a permitted state. Both are
    // "did not move", and the caller decides what that means.
    return result.affectedRows === 1;
  }
}
