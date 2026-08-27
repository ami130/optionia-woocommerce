import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StorePlatform, StoreStatus } from '../common/database/enums';
import { generateToken, hashToken } from '../common/crypto/tokens';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AuthorizeDto, InitiateDto } from './dto/connect.dto';

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
     */
    if (
      !request ||
      request.approvedAt !== null ||
      new Date(request.requestExpiresAt).getTime() <= Date.now() ||
      hashToken(dto.state) !== request.stateHash
    ) {
      throw ConnectService.invalidRequest();
    }

    const code = generateToken();

    return this.dataSource.transaction(async (manager) => {
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
    });
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
    manager: { query(sql: string, params?: unknown[]): Promise<never> },
    tenantId: string,
    siteUrl: string,
  ): Promise<{ storeId: string; reconnected: boolean }> {
    const existing: Array<{ id: string }> = await manager.query(
      `SELECT id FROM stores WHERE tenantId = ? AND storeUrl = ? LIMIT 1`,
      [tenantId, siteUrl],
    );

    if (existing[0]) {
      await manager.query(
        `UPDATE stores SET status = ?, updatedAt = NOW(3) WHERE id = ?`,
        [StoreStatus.CONNECTING, existing[0].id],
      );

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
