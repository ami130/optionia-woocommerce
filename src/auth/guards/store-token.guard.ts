import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';

import { getContext } from '../../common/context/request-context';
import { hashToken } from '../../common/crypto/tokens';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * How stale `last_used_at` is allowed to become before a request rewrites it.
 *
 * The column answers "when did this store last talk to us" for support and for
 * spotting dead installs. That question is asked in days; writing on every
 * request would turn a read path into a write path for precision nobody uses —
 * and the heartbeat alone is 60 requests an hour per store.
 */
const LAST_USED_THROTTLE_MS = 5 * 60_000;

/**
 * Requires a valid **store credential** — an opaque token, not a JWT.
 *
 * ## Why not a JWT
 *
 * [M8.6](../../../developePlan.md) requires revocation to be *immediate*, and a
 * JWT cannot be un-issued: a revoked store would keep working until its token
 * expired. The credential is therefore a random secret whose SHA-256 lives in
 * `store_credentials`, checked against the database on every request. That is a
 * lookup a JWT avoids, and buying revocation with it is the trade M8.6 names.
 *
 * ## Every failure is the same 401
 *
 * Missing header, unknown token, revoked, expired, or a credential whose store
 * has since been deleted — all identical to the caller. Distinguishing them
 * tells an attacker which half of a guess was right. It also means the plugin's
 * reconnect path has exactly one trigger to recognise.
 *
 * ## What it puts in the context
 *
 * `tenantId` and `realm`, and deliberately **no `userId`** — a store is not a
 * person. The context already models this: `userId` is optional, `audit_logs`
 * stores it nullable, and the scoped repository layer reads `tenantId` alone. So
 * a store-authenticated write is tenant-scoped and audited exactly like a user's,
 * with the actor recorded as absent rather than invented.
 */
@Injectable()
export class StoreTokenGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerToken(request);

    if (!presented) {
      throw StoreTokenGuard.unauthenticated();
    }

    /**
     * Looked up **by hash**, which is also the only way it can be looked up:
     * the plaintext is never stored. `ix_store_credentials_token` makes this one
     * probe rather than a scan.
     *
     * Joined to `stores` because the credential carries no tenant of its own —
     * it reaches one only through its store, and an `INNER JOIN` means a
     * credential whose store was deleted resolves to no row, which is the same
     * 401 as an unknown token rather than a crash on a missing tenant.
     */
    const rows: Array<{
      id: string;
      storeId: string;
      tenantId: string;
      storeUrl: string;
      revokedAt: Date | null;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
    }> = await this.dataSource.query(
      `SELECT sc.id, sc.storeId, s.tenantId, s.storeUrl, sc.revokedAt, sc.expiresAt, sc.lastUsedAt
         FROM store_credentials sc
         JOIN stores s ON s.id = sc.storeId
        WHERE sc.tokenHash = ?
        LIMIT 1`,
      [hashToken(presented)],
    );

    const credential = rows[0];

    if (!credential) {
      throw StoreTokenGuard.unauthenticated();
    }

    // Revocation is why this guard reads the database at all (M8.6).
    if (credential.revokedAt !== null) {
      throw StoreTokenGuard.unauthenticated();
    }

    /**
     * `expires_at` is nullable, and null means *no expiry* — a connected store
     * is not asked to re-authorise on a timer.
     *
     * Written as an explicit null check rather than a falsy one: `new Date(0)`
     * is falsy in neither JS nor SQL, but a `!credential.expiresAt` test would
     * still read as "no expiry" for anything the driver returned oddly, which is
     * the kind of accident that grants a permanent credential.
     */
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.now()) {
      throw StoreTokenGuard.unauthenticated();
    }

    await this.touchLastUsed(credential.id, credential.lastUsedAt);

    const ctx = getContext();

    if (ctx) {
      ctx.realm = 'store';
      ctx.tenantId = credential.tenantId;
      ctx.storeId = credential.storeId;
      // For `SiteMatchGuard`, which runs next. Free here: the join is already
      // being made to resolve the tenant.
      ctx.storeUrl = credential.storeUrl;
      // `userId` stays undefined: a store is not a person, and inventing an
      // actor here would put a fabricated id on every audit entry it writes.
    }

    return true;
  }

  /**
   * Record that the credential was used, at most once every few minutes.
   *
   * Throttled rather than written every time: this runs on a read path, and the
   * column's consumers — support, and stale-install detection — ask the question
   * in days. Unthrottled it would add a write to all 60 heartbeats an hour per
   * store, plus every config fetch, to sharpen a timestamp nobody reads that
   * finely.
   *
   * Failures are swallowed. A telemetry write must never turn an authenticated
   * request into a 500 — the credential is valid whether or not we managed to
   * note the time.
   */
  private async touchLastUsed(credentialId: string, lastUsedAt: Date | null): Promise<void> {
    const isFresh =
      lastUsedAt !== null && Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS;

    if (isFresh) {
      return;
    }

    try {
      await this.dataSource.query(`UPDATE store_credentials SET lastUsedAt = NOW(3) WHERE id = ?`, [
        credentialId,
      ]);
    } catch {
      // Deliberately ignored — see above.
    }
  }

  /** One rejection for every cause, so none of them is a hint. */
  private static unauthenticated(): DomainException {
    return new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
  }
}

/**
 * Extract a bearer token.
 *
 * The plugin already ships `Authorization: Bearer <token>` (`Api/Client.php`),
 * and under M7.7 the installed plugin cannot be redeployed — so the header shape
 * is a fact the cloud adapts to, not a choice reopened here.
 *
 * Returns an empty string rather than throwing on a malformed header, so every
 * shape of failure reaches the same single rejection.
 */
function bearerToken(request: Request): string {
  const header = request.headers.authorization ?? '';
  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value : '';
}
