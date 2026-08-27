import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StorePlatform, StoreStatus } from '../common/database/enums';
import {
  generateStoreToken,
  generateToken,
  hashToken,
  tokensMatch,
} from '../common/crypto/tokens';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AuthorizeDto, ExchangeDto, InitiateDto } from './dto/connect.dto';
import { StoreStateService } from './store-state.service';

/** A pending request lives 30 minutes — a human signs up and reads a screen. */
const REQUEST_TTL_MS = 30 * 60_000;

/** An approved code lives 5 minutes (M8.1) — redemption is machine-to-machine. */
const CODE_TTL_MS = 5 * 60_000;

export interface InitiateResult {
  readonly authorize_url: string;
}

export interface AuthorizeResult {
  readonly redirect_url: string;
}

export interface ExchangeResult {
  /** Shown once. `store_credentials` holds only its hash. */
  readonly token: string;
  readonly store_id: string;
  readonly tenant_name: string;
  readonly config_version: number;
}

/**
 * The connection handshake (M8.1, M8.2).
 *
 * Two of its three steps live here; `exchange` is `[8e]`. The flow is linear —
 * a request is created, approved once, redeemed once — and each step is
 * deliberately unable to undo the one before it.
 */
@Injectable()
export class ConnectService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly state: StoreStateService,
    private readonly appUrl: string,
  ) {}

  /**
   * Begin a handshake. Unauthenticated: no credential exists yet.
   *
   * Returns the URL the plugin sends the merchant to. **The cloud builds it**,
   * rather than the plugin assembling one from a hard-coded host: under M7.7 an
   * installed plugin cannot be redeployed, so a URL shape baked into it would be
   * permanent.
   */
  async initiate(dto: InitiateDto): Promise<InitiateResult> {
    const siteUrl = normaliseUrl(dto.site_url);
    const callback = dto.callback.trim();

    /**
     * The callback must share the site's origin.
     *
     * Compared as *origins* rather than by prefix: `https://shop.example.com.evil
     * .test` starts with the site URL as a string and is a different host. A
     * prefix check here is an open redirect that delivers the code to the
     * attacker.
     */
    if (originOf(callback) !== originOf(siteUrl)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'callback must share an origin with site_url.',
      );
    }

    const id = uuidv7();

    await this.dataSource.query(
      `INSERT INTO store_connection_codes
         (id, createdAt, updatedAt, siteUrl, callback, stateHash, challenge,
          pluginVersion, requestExpiresAt)
       VALUES (?, NOW(3), NOW(3), ?, ?, ?, ?, ?, ?)`,
      [
        id,
        siteUrl,
        callback,
        hashToken(dto.state),
        dto.challenge,
        dto.plugin_version ?? null,
        new Date(Date.now() + REQUEST_TTL_MS),
      ],
    );

    /**
     * `state` rides back in the URL, and that is deliberate.
     *
     * Only its hash is stored, so the cloud cannot reproduce the plaintext later
     * — and the plugin must receive its original `state` on the callback or it
     * cannot verify the response belongs to the handshake it began. The value is
     * already destined for this browser; carrying it exposes nothing new.
     */
    const url = new URL('/connect', this.appUrl);

    url.searchParams.set('request', id);
    url.searchParams.set('state', dto.state);

    return { authorize_url: url.toString() };
  }

  /**
   * A merchant approves connecting a site to their tenant.
   *
   * The only step with a human in it, and the only one that decides *which*
   * workspace a site joins.
   */
  async authorize(dto: AuthorizeDto, tenantId: string): Promise<AuthorizeResult> {
    const [request] = await this.dataSource.query(
      `SELECT id, siteUrl, callback, stateHash, requestExpiresAt, approvedAt
         FROM store_connection_codes WHERE id = ? LIMIT 1`,
      [dto.request],
    );

    /**
     * Unknown, already approved, expired, or the wrong `state` — one refusal.
     *
     * Distinguishing them would let a caller enumerate request ids and learn
     * which exist, which is exactly what the rate limit and this uniform error
     * exist to prevent together.
     *
     * `state` is compared with `tokensMatch` rather than `!==`.
     *
     * This is the **only** in-process hash comparison in the codebase: every
     * other secret — refresh tokens, password resets, store credentials — is
     * found by an indexed lookup on its hash, where the database does the
     * matching and no timing channel exists in our code. That is why
     * `tokensMatch` was written for Phase 6 and had no caller until now.
     *
     * The channel is weak on a digest, since an attacker cannot walk it
     * byte-by-byte without already holding the preimage. It is used anyway
     * because the correct comparison costs nothing here and leaving the one
     * comparison site on `!==` is what makes a helper look decorative.
     */
    if (
      !request ||
      request.approvedAt !== null ||
      new Date(request.requestExpiresAt).getTime() <= Date.now() ||
      !tokensMatch(hashToken(dto.state), request.stateHash)
    ) {
      throw ConnectService.invalidRequest();
    }

    const code = generateToken();

    const { storeId, reconnected } = await this.dataSource.transaction(async (manager) => {
      /**
       * Claim the request with a conditional write, not a read then a write.
       *
       * Two simultaneous approvals must not mint two codes. The check above is a
       * fast rejection for the ordinary case; **this** is the one that decides,
       * because only one `UPDATE` can match `approvedAt IS NULL`.
       *
       * A `SELECT … FOR UPDATE` would also close the window and was rejected:
       * ADR history records it being built and removed elsewhere for taking locks
       * in an order that deadlocked against the delete path.
       */
      const claimed = await manager.query(
        `UPDATE store_connection_codes
            SET approvedAt = NOW(3), codeHash = ?, codeExpiresAt = ?,
                tenantId = ?, updatedAt = NOW(3)
          WHERE id = ? AND approvedAt IS NULL`,
        [code.hash, new Date(Date.now() + CODE_TTL_MS), tenantId, dto.request],
      );

      if (claimed.affectedRows !== 1) {
        throw ConnectService.invalidRequest();
      }

      const { storeId, reconnected } = await this.createOrReuseStore(
        manager,
        tenantId,
        request.siteUrl,
      );

      await manager.query(`UPDATE store_connection_codes SET storeId = ? WHERE id = ?`, [
        storeId,
        dto.request,
      ]);

      return { storeId, reconnected };
    });

    /**
     * Audited **after** the transaction commits, never inside it.
     *
     * `AuditService` writes through its own repository — a different connection
     * — so an entry recorded inside the callback survives a rollback and reports
     * a connection that never happened. A phantom entry is worse than a missing
     * one: it sends whoever reads the trail looking for a store that does not
     * exist. Every other service in this codebase records after its transaction
     * for the same reason.
     *
     * The trade is the opposite failure — a commit whose audit write then fails —
     * and `record` swallows that deliberately, leaving an incomplete trail rather
     * than undoing an action that already happened.
     */
    await this.audit.record({
      action: reconnected
        ? AuditAction.STORE_RECONNECT_AUTHORIZED
        : AuditAction.STORE_CONNECT_AUTHORIZED,
      resourceType: 'store',
      resourceId: storeId,
      changes: { siteUrl: request.siteUrl, status: StoreStatus.CONNECTING },
    });

    const redirect = new URL(request.callback);

    redirect.searchParams.set('code', code.plaintext);
    redirect.searchParams.set('state', dto.state);

    return { redirect_url: redirect.toString() };
  }

  /**
   * Redeem a code for a store credential, server-to-server (M8.1).
   *
   * The last step, and the only irreversible one: it mints a long-lived secret
   * and moves the store to `CONNECTED`. The browser is not involved.
   */
  async exchange(dto: ExchangeDto): Promise<ExchangeResult> {
    const [row] = await this.dataSource.query(
      `SELECT c.id, c.siteUrl, c.challenge, c.codeExpiresAt, c.redeemedAt,
              c.tenantId, c.storeId, t.name AS tenantName
         FROM store_connection_codes c
         JOIN tenants t ON t.id = c.tenantId
        WHERE c.codeHash = ? LIMIT 1`,
      [hashToken(dto.code)],
    );

    /**
     * Five ways to fail, one answer.
     *
     * Unknown code, already spent, expired, wrong verifier, wrong site — all
     * `TOKEN_INVALID` with the same message. Telling an attacker which of the
     * five they failed tells them exactly what to fix, and the code is one
     * exchange away from a credential.
     *
     * The `JOIN` on `tenants` is part of the check rather than a convenience: a
     * code whose tenant is gone resolves to no row, which is the same refusal
     * instead of a crash on a missing name.
     */
    if (
      !row ||
      row.redeemedAt !== null ||
      row.codeExpiresAt === null ||
      new Date(row.codeExpiresAt).getTime() <= Date.now() ||
      !tokensMatch(pkceChallenge(dto.verifier), row.challenge) ||
      normaliseUrl(dto.site_url) !== row.siteUrl
    ) {
      throw ConnectService.invalidRequest();
    }

    const credential = generateStoreToken();

    await this.dataSource.transaction(async (manager) => {
      /**
       * Spend the code with a conditional write, exactly as `authorize` claims
       * a request.
       *
       * The read above rejects an already-spent code in the ordinary case; this
       * is what decides between two simultaneous redemptions, because only one
       * `UPDATE` can match `redeemedAt IS NULL`.
       */
      const spent = await manager.query(
        `UPDATE store_connection_codes SET redeemedAt = NOW(3), updatedAt = NOW(3)
          WHERE id = ? AND redeemedAt IS NULL`,
        [row.id],
      );

      if (spent.affectedRows !== 1) {
        throw ConnectService.invalidRequest();
      }

      await manager.query(
        `INSERT INTO store_credentials
           (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
         VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
        [row.storeId, credential.hash, credential.prefix],
      );

      /**
       * Same transaction as the spend, so a failure cannot leave a store
       * connected with no credential, or a credential with no connected store.
       *
       * **Guarded**: only a store still `CONNECTING` (or recovering from
       * `ERROR`) may arrive at `CONNECTED`. Without that precondition a code
       * redeemed after the merchant disconnected would silently undo the
       * disconnection — reachable with no attacker, just a failed exchange the
       * plugin retries and an impatient merchant in between. The refusal is the
       * same `TOKEN_INVALID` as every other, so the caller learns nothing about
       * why.
       */
      const connected = await this.state.transition(row.storeId, StoreStatus.CONNECTED, {
        manager,
      });

      if (!connected) {
        throw ConnectService.invalidRequest();
      }
    });

    /**
     * Audited after the commit, with the tenant named explicitly.
     *
     * This route is `@Public()` and has no tenant in context — but unlike
     * `initiate`, the tenant is knowable: `authorize` recorded it on the code.
     * Naming it keeps a completed connection visible to the tenant-scoped audit
     * query rather than writing a row nobody can read.
     */
    await this.audit.record({
      action: AuditAction.STORE_CONNECTED,
      resourceType: 'store',
      resourceId: row.storeId,
      tenantId: row.tenantId,
      changes: { status: StoreStatus.CONNECTED, siteUrl: row.siteUrl },
    });

    const [store] = await this.dataSource.query(
      `SELECT configVersion FROM stores WHERE id = ? LIMIT 1`,
      [row.storeId],
    );

    return {
      token: credential.plaintext,
      store_id: row.storeId,
      tenant_name: row.tenantName,
      config_version: Number(store?.configVersion ?? 0),
    };
  }

  /**
   * The store this approval refers to, creating it only if the tenant has none.
   *
   * **Reconnection reuses the row.** `uq_stores_tenant_url` is
   * `(tenant_id, store_url)` and M8.1b runs `REVOKED → DISCONNECTED →
   * CONNECTING`, so re-approving a site the tenant already holds is the recovery
   * path, not a conflict. Reuse also preserves `store_id`, and with it the
   * store's history, analytics and every row referencing it — a second row would
   * orphan all three silently.
   *
   * ⚠️ **Scoped by tenant, which is the security boundary.** The same URL under
   * another tenant is a different store — an agency and its client legitimately
   * share an address — so the lookup is `(tenantId, storeUrl)` and never URL
   * alone. Matching on URL would let one tenant's approval seize another's store.
   */
  private async createOrReuseStore(
    manager: EntityManager,
    tenantId: string,
    siteUrl: string,
  ): Promise<{ storeId: string; reconnected: boolean }> {
    const existing: Array<{ id: string }> = await manager.query(
      `SELECT id FROM stores WHERE tenantId = ? AND storeUrl = ? LIMIT 1`,
      [tenantId, siteUrl],
    );

    if (existing[0]) {
      /**
       * Every state may begin a handshake, so the machine cannot refuse this on
       * state — but it *can* report no rows when the store was deleted between
       * the lookup above and this write.
       *
       * The result is checked rather than discarded. Left unchecked, that race
       * carried on to `UPDATE store_connection_codes SET storeId = …` and failed
       * on the foreign key — a 500 from a constraint, where the condition was
       * knowable one statement earlier. The data was never at risk; the error
       * was just far from its cause.
       */
      const reconnecting = await this.state.transition(
        existing[0].id,
        StoreStatus.CONNECTING,
        { manager },
      );

      if (!reconnecting) {
        throw ConnectService.invalidRequest();
      }

      return { storeId: existing[0].id, reconnected: true };
    }

    const storeId = uuidv7();

    await manager.query(
      `INSERT INTO stores
         (id, createdAt, updatedAt, tenantId, platform, name, storeUrl, status, configVersion)
       VALUES (?, NOW(3), NOW(3), ?, ?, ?, ?, ?, 0)`,
      [storeId, tenantId, StorePlatform.WOOCOMMERCE, hostOf(siteUrl), siteUrl, StoreStatus.CONNECTING],
    );

    return { storeId, reconnected: false };
  }

  /** One refusal for every cause, so none of them is a hint. */
  private static invalidRequest(): DomainException {
    return new DomainException(
      ErrorCode.TOKEN_INVALID,
      'This connection request is no longer valid.',
    );
  }
}

/**
 * A URL reduced to what identifies the site.
 *
 * Lowercased host, no trailing slash — `https://Shop.example.com/` and
 * `https://shop.example.com` are the same site, and `[8i]` compares a stored URL
 * against a header the plugin sends as `home_url( '/' )`, which carries the
 * slash. Normalising on the way in means the comparison later is equality.
 */
export function normaliseUrl(value: string): string {
  const url = new URL(value.trim());
  const path = url.pathname.replace(/\/+$/, '');

  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/** Scheme, host and port — what "same origin" means. */
function originOf(value: string): string {
  try {
    const url = new URL(value.trim());

    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    // An unparseable URL matches no origin, so the comparison refuses it.
    return '';
  }
}

/** A default display name, replaced by the merchant later. */
function hostOf(value: string): string {
  try {
    return new URL(value).host.toLowerCase().slice(0, 255);
  } catch {
    return value.slice(0, 255);
  }
}

/**
 * The PKCE S256 challenge for a verifier: `base64url(SHA-256(verifier))`.
 *
 * Produced here and compared against the stored challenge, which is kept exactly
 * as the plugin sent it. Hashing the stored value again would compare
 * `SHA-256(SHA-256(verifier))` against `SHA-256(verifier)` — a check that fails
 * for every honest client while looking like defence in depth.
 */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}
