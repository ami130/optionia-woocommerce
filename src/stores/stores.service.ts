import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StoreStatus } from '../common/database/enums';
import { generateStoreToken } from '../common/crypto/tokens';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { StoresRepository } from './stores.repository';
import { StoreStateService } from './store-state.service';

export interface DisconnectResult {
  readonly status: StoreStatus;
  readonly credentials_revoked: number;
}

export interface HeartbeatResult {
  /** What the cloud has, so a plugin learns it is behind. */
  readonly config_version: number;
  /** The cloud's view of the connection — never the plugin's, echoed back. */
  readonly status: StoreStatus;
  /** Whether a fresh handshake is required. Structurally false until `[8i]`. */
  readonly reauthorize: boolean;
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
   * The daily ping from a connected plugin (M8.5).
   *
   * Authenticated by the store realm, so the store is already resolved from the
   * credential — there is no id in the path and nothing for a caller to name.
   *
   * Records what the install is running, answers what the cloud has, and
   * reconciles the two views of the connection without resolving them.
   */
  async heartbeat(storeId: string, dto: HeartbeatDto): Promise<HeartbeatResult> {
    const [store] = await this.dataSource.query(
      `SELECT id, tenantId, status, configVersion, storeUrl FROM stores WHERE id = ? LIMIT 1`,
      [storeId],
    );

    if (!store) {
      // The guard resolved a credential whose store has since gone. Same 401 as
      // any other failure, so a caller learns nothing from which one it hit.
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    /**
     * Telemetry, written every time.
     *
     * `lastSeenAt` is deliberately not throttled the way the guard throttles
     * `lastUsedAt`: this is a **daily** request, and the column is indexed
     * precisely so stale installs are visible without asking. Skipping the write
     * would defeat the one thing it is for.
     *
     * The two columns are not duplicates — `stores.last_seen_at` answers "did
     * this install check in", `store_credentials.last_used_at` answers "was this
     * credential used".
     */
    await this.dataSource.query(
      `UPDATE stores
          SET lastSeenAt = NOW(3),
              pluginVersion = COALESCE(?, pluginVersion),
              wpVersion = COALESCE(?, wpVersion),
              wcVersion = COALESCE(?, wcVersion),
              phpVersion = COALESCE(?, phpVersion),
              updatedAt = NOW(3)
        WHERE id = ?`,
      [
        dto.plugin_version ?? null,
        dto.wp_version ?? null,
        dto.wc_version ?? null,
        dto.php_version ?? null,
        storeId,
      ],
    );

    /**
     * Reconciliation: record the disagreement, resolve nothing.
     *
     * **`stores.status` is never written from `connection_state`.** The plugin's
     * view is one of the two things in dispute — a cloned staging site reports on
     * a production store it is impersonating, and adopting its claim would let a
     * clone degrade the original. M8.1b calls guessing here the largest source of
     * support tickets in this category of product.
     *
     * Reported only when the plugin actually sent a view. A silent heartbeat is
     * not a disagreement.
     */
    if (dto.connection_state !== undefined && dto.connection_state !== store.status) {
      /**
       * Record the disagreement **once**, not once per ping.
       *
       * A store that cannot be reconciled — a cloned site, a restored database —
       * disagrees on every heartbeat. `recordChange` compares against the last
       * entry of the same kind and writes only when something actually moved:
       * a changed claim from the plugin, or a changed view from the cloud.
       */
      await this.audit.recordChange(
        {
          action: AuditAction.STORE_STATE_MISMATCH,
          resourceType: 'store',
          resourceId: storeId,
          // The store realm carries no user, and `authorize` recorded the tenant
          // on the store — so the entry stays visible to the tenant-scoped query.
          tenantId: store.tenantId,
          changes: {
            pluginState: dto.connection_state,
            cloudState: store.status,
            siteUrl: store.storeUrl,
          },
        },
        // `siteUrl` is carried but not compared: it identifies the store, not
        // the disagreement, and comparing it would change nothing.
        ['pluginState', 'cloudState'],
      );
    }

    return {
      config_version: safeInteger(store.configVersion, 'stores.configVersion'),
      status: store.status as StoreStatus,
      /**
       * Structurally `false` until `[8i]`.
       *
       * Neither trigger can fire here: a site-URL change is detected in `[8i]`,
       * and a revoked credential never reaches this handler because
       * `StoreTokenGuard` answers `401` first. The field ships regardless — the
       * plugin cannot be redeployed (M7.7) to start reading it later.
       */
      reauthorize: false,
    };
  }

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

/**
 * A `BIGINT` read through a raw query, refused rather than truncated.
 *
 * `bigintTransformer` throws on a value JavaScript cannot represent exactly, and
 * that guard exists because silent truncation is the failure it was written to
 * prevent. A raw `dataSource.query` bypasses the transformer entirely, so the
 * same check is applied here — otherwise the one query in the codebase that reads
 * `configVersion` outside the entity is also the one that quietly opts out.
 */
function safeInteger(value: unknown, column: string): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = typeof value === 'string' ? Number(value) : (value as number);

  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${column} holds ${String(value)}, which cannot be represented exactly.`);
  }

  return parsed;
}

