import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StoreStatus } from '../common/database/enums';
import { generateStoreToken } from '../common/crypto/tokens';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { StoresRepository } from './stores.repository';
import { StoreStateService } from './store-state.service';

export interface DisconnectResult {
  readonly status: StoreStatus;
  readonly credentials_revoked: number;
}

export interface RotateResult {
  /** Shown once. `store_credentials` holds only its hash. */
  readonly token: string;
  /** The eight characters after the marker — what tells two credentials apart. */
  readonly prefix: string;
  readonly rotated_at: string;
}

/**
 * Store ownership acts: disconnect and credential rotation (M8.6).
 *
 * Both are destructive and both are the merchant's own — which is why they carry
 * `stores:connect` and `stores:rotate_credential` rather than an authoring
 * capability, and why the store is resolved through a tenant-scoped repository
 * so another tenant's id is a 404 rather than a 403.
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly stores: StoresRepository,
    private readonly state: StoreStateService,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Disconnect a store: revoke every live credential, move to `DISCONNECTED`.
   *
   * **Idempotent** (M8.6). Disconnecting an already-disconnected store answers
   * `200` with `credentials_revoked: 0` — a merchant clicking twice is not an
   * error, and the contract returns the resulting status rather than a changed
   * flag precisely so this reads the same either way.
   *
   * **The storefront keeps working.** Revocation stops the plugin receiving new
   * configuration; it does not stop it serving the copy it already holds (AC3).
   */
  async disconnect(storeId: string): Promise<DisconnectResult> {
    const store = await this.stores.findById(storeId);

    if (!store) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Store not found.');
    }

    const revoked = await this.dataSource.transaction(async (manager) => {
      /**
       * Revoke first, then move the state.
       *
       * If the order were reversed and the credential update failed, the store
       * would read `DISCONNECTED` while a live credential still authenticated —
       * the disagreement M8.1b exists to prevent. Both are in one transaction, so
       * neither can happen alone; the ordering only decides which is attempted
       * first.
       */
      const result = await manager.query(
        `UPDATE store_credentials SET revokedAt = NOW(3), updatedAt = NOW(3)
          WHERE storeId = ? AND revokedAt IS NULL`,
        [storeId],
      );

      /**
       * Every state may reach `DISCONNECTED`, so this cannot refuse on state —
       * but it reports no rows if the store was deleted between the lookup above
       * and this write.
       *
       * Checked rather than discarded. Unchecked, the handler would answer
       * `{ status: 'disconnected' }` for a store that no longer exists: nothing
       * is corrupted, because the store is gone and no credential outlives it,
       * but the response would be a statement about a row that isn't there.
       */
      const moved = await this.state.transition(storeId, StoreStatus.DISCONNECTED, { manager });

      if (!moved) {
        throw new DomainException(ErrorCode.NOT_FOUND, 'Store not found.');
      }

      /**
       * Finding 3: spend any pending connection code for this store.
       *
       * `[8f]`'s state guard already refuses to move a `DISCONNECTED` store to
       * `CONNECTED`, so an unspent code cannot resurrect it. This is defence in
       * depth rather than a fix: a code that looks redeemable for its remaining
       * five minutes is an artefact someone will eventually reason about
       * incorrectly, and the merchant's disconnect is a clear statement that the
       * handshake it belongs to is over.
       */
      await manager.query(
        `UPDATE store_connection_codes SET redeemedAt = NOW(3), updatedAt = NOW(3)
          WHERE storeId = ? AND redeemedAt IS NULL`,
        [storeId],
      );

      return Number(result.affectedRows ?? 0);
    });

    /**
     * Audited after the commit, and only when something changed.
     *
     * A second click revokes nothing and moves nothing; recording it would fill
     * the trail with events that describe no change.
     */
    if (revoked > 0 || store.status !== StoreStatus.DISCONNECTED) {
      await this.audit.record({
        action: AuditAction.STORE_DISCONNECTED,
        resourceType: 'store',
        resourceId: storeId,
        changes: { status: StoreStatus.DISCONNECTED, credentialsRevoked: revoked },
      });
    }

    return { status: StoreStatus.DISCONNECTED, credentials_revoked: revoked };
  }

  /**
   * Replace a store's credential, revoking the old one immediately.
   *
   * **No grace period.** A rotation a merchant asked for because they believe
   * the token leaked must take effect at once; a window in which both work is a
   * window in which the leaked one still works (M8.6).
   *
   * The store's state does not change — it stays `CONNECTED` throughout — which
   * is why this records `store.credential_rotated` rather than a state action.
   */
  async rotate(storeId: string, reason?: string): Promise<RotateResult> {
    const store = await this.stores.findById(storeId);

    if (!store) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Store not found.');
    }

    /**
     * Only a store holding a live credential has one worth replacing.
     *
     * **`ERROR` counts.** An erroring store reached that state from `CONNECTED`
     * on a sync or auth failure, and nothing revokes on the way in — its
     * credential is still live, which is why M8.1b has it keep serving cache and
     * recover. A merchant whose store is erroring and who suspects that error
     * *is* a compromised token is exactly who this endpoint exists for; an
     * earlier guard of `!== CONNECTED` refused them, making the security feature
     * unavailable in the state that most suggests it is needed.
     *
     * `DISCONNECTED` and `REVOKED` had theirs revoked; `CONNECTING` has not been
     * issued one. For those the answer is to connect, not to rotate.
     *
     * `CONFLICT` rather than `NOT_FOUND`: the store exists and the caller may see
     * it, so hiding it would mislead — this is a state problem the merchant can
     * fix.
     */
    if (store.status !== StoreStatus.CONNECTED && store.status !== StoreStatus.ERROR) {
      throw new DomainException(
        ErrorCode.CONFLICT,
        'This store holds no live credential to rotate.',
      );
    }

    const credential = generateStoreToken();
    const rotatedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE store_credentials SET revokedAt = NOW(3), updatedAt = NOW(3)
          WHERE storeId = ? AND revokedAt IS NULL`,
        [storeId],
      );

      // Same transaction, so a failure cannot leave a store with every
      // credential revoked and no replacement — which would disconnect a store
      // the merchant only asked to re-key.
      await manager.query(
        `INSERT INTO store_credentials
           (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
         VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
        [storeId, credential.hash, credential.prefix],
      );
    });

    await this.audit.record({
      action: AuditAction.STORE_CREDENTIAL_ROTATED,
      resourceType: 'store',
      resourceId: storeId,
      // The reason lives here rather than on the credential: `store_credentials`
      // has no column for it, and the trail is where the contract promises it.
      changes: { prefix: credential.prefix, reason: reason ?? null },
    });

    return {
      token: credential.plaintext,
      prefix: credential.prefix,
      rotated_at: rotatedAt.toISOString(),
    };
  }
}
