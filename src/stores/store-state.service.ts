import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StoreStatus } from '../common/database/enums';
import { allowedPredecessors } from './store-state';

/** What a caller must know after attempting a transition. */
export interface TransitionResult {
  /** False when the store was not in a state this transition permits. */
  readonly moved: boolean;
  /** The state the store was in, for an audit entry or an error message. */
  readonly from: StoreStatus | null;
}

/** The audit action recording arrival in each state (M8.1b: every transition is logged). */
const ACTION_FOR: Readonly<Record<StoreStatus, AuditAction>> = {
  [StoreStatus.CONNECTING]: AuditAction.STORE_CONNECT_AUTHORIZED,
  [StoreStatus.CONNECTED]: AuditAction.STORE_CONNECTED,
  [StoreStatus.ERROR]: AuditAction.STORE_ERRORED,
  [StoreStatus.DISCONNECTED]: AuditAction.STORE_DISCONNECTED,
  [StoreStatus.REVOKED]: AuditAction.STORE_REVOKED,
};

/**
 * Performs connection-state transitions, and refuses the ones M8.1b forbids.
 *
 * Every `stores.status` write goes through here. `bin/check-store-state.ts`
 * enforces that: a raw `UPDATE stores SET status` anywhere else fails the build,
 * because a convention that is merely documented is one the next step forgets.
 */
@Injectable()
export class StoreStateService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

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
    options: { manager?: EntityManager; tenantId?: string; reason?: string } = {},
  ): Promise<TransitionResult> {
    const runner = options.manager ?? this.dataSource;
    const from = allowedPredecessors(to);

    if (from.length === 0) {
      return { moved: false, from: null };
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

    if (result.affectedRows !== 1) {
      // Either the store is gone or it was not in a permitted state. Both are
      // "did not move", and the caller decides what that means.
      const [row] = await runner.query(`SELECT status FROM stores WHERE id = ? LIMIT 1`, [
        storeId,
      ]);

      return { moved: false, from: (row?.status as StoreStatus) ?? null };
    }

    return { moved: true, from: null };
  }

  /**
   * Record a completed transition.
   *
   * Separate from `transition` and deliberately so: audit rows are written
   * **after** the transaction commits, and `transition` often runs inside one.
   * An entry written inside a transaction that later rolls back survives it and
   * reports a change that never happened — demonstrated, and the reason every
   * service here audits after its commit.
   */
  async record(
    storeId: string,
    to: StoreStatus,
    options: { tenantId?: string; changes?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.audit.record({
      action: ACTION_FOR[to],
      resourceType: 'store',
      resourceId: storeId,
      tenantId: options.tenantId,
      changes: { status: to, ...options.changes },
    });
  }
}
