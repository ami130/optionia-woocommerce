import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { normaliseUrl } from '../../stores/connect.service';

/** The header WordPress fills with `home_url( '/' )` on every request. */
export const SITE_HEADER = 'x-optionia-site';

/**
 * Refuses a request from a site the credential was not issued to (M8.1b).
 *
 * A cloned staging site inherits production's credential and would begin
 * reporting orders as though it were the live shop. The clone reports **its own**
 * URL while the credential still names the original, which is precisely what
 * makes the mismatch detectable.
 *
 * ## Why this is not part of `StoreTokenGuard`
 *
 * That guard answers *"is this credential valid"* and holds an invariant worth
 * keeping: every failure is the same `401`, so a caller learns nothing from which
 * one they hit. This answers a different question — *"is this the site it was
 * issued to"* — and answers `403`, because the credential **is** genuine. A `401`
 * would send the plugin into a reconnect loop that retrying cannot win, since the
 * new credential would be presented from the same wrong address.
 *
 * Separate also means Phase 9's config-sync routes inherit both by adding one
 * decorator rather than by remembering a check.
 *
 * ## It refuses. It never revokes.
 *
 * `X-Optionia-Site` is a plain header and whoever holds the credential controls
 * its value. Revoking on a mismatch would let a stolen token **disconnect the
 * merchant's live store** — turning a read-only compromise into a denial of
 * service — and would kill a legitimate domain migration on its first request.
 *
 * So the clone is blocked and the original keeps working, which is what M8.1b
 * asks for: *"a cloned site cannot **silently** reuse the original's
 * credential."* Silently is the operative word, so every mismatch is audited and
 * a human decides what it means.
 */
@Injectable()
export class SiteMatchGuard implements CanActivate {
  constructor(private readonly audit: AuditService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = getContext();

    /**
     * No store in context means `StoreTokenGuard` did not run.
     *
     * Admitting the request would make this guard a decoration on a route that
     * is already unauthenticated. Refusing keeps a misordered chain closed.
     */
    if (!ctx?.storeId || !ctx.storeUrl) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[SITE_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;

    /**
     * A missing header is not a mismatch.
     *
     * Every shipped plugin sends it (`Api/Client.php`), but a future client, a
     * proxy that strips unknown headers, or a support engineer with `curl` would
     * not — and refusing them would make this guard an availability risk for no
     * security gain. A caller that omits the header has told us nothing; a caller
     * that sends the wrong one has told us something.
     */
    if (typeof presented !== 'string' || presented.trim() === '') {
      return true;
    }

    if (safeNormalise(presented) === safeNormalise(ctx.storeUrl)) {
      return true;
    }

    /**
     * Audited **before** the refusal, because the throw ends the request.
     *
     * `record` swallows its own failures, so a failed audit cannot turn a
     * refusal into a `500` — the request is refused either way, and an
     * incomplete trail is the lesser outcome.
     *
     * **Recorded once per distinct site, not once per request.** A clone sends
     * the same wrong URL on every heartbeat, and at 60 an hour that is 1,440
     * entries a day for one store — into a table with no retention sweep. The
     * condition persists; the event does not repeat. A clone appearing at a
     * *different* address is news and is recorded.
     */
    await this.audit.recordChange(
      {
        action: AuditAction.STORE_SITE_MISMATCH,
        resourceType: 'store',
        resourceId: ctx.storeId,
        // The store realm carries no user; the tenant came from the credential.
        tenantId: ctx.tenantId,
        changes: { expected: ctx.storeUrl, presented: presented.trim().slice(0, 255) },
      },
      // `expected` is the store's own URL and cannot vary between requests, so
      // the presented address is what makes one refusal different from another.
      ['presented'],
    );

    throw new DomainException(
      ErrorCode.FORBIDDEN,
      'This credential was issued to a different site. Reconnect to continue.',
    );
  }
}

/**
 * Normalise for comparison, falling back to the raw value.
 *
 * `normaliseUrl` throws on an unparseable string, and a caller controls this
 * header. Returning the trimmed original means a junk value simply fails to
 * match — which is the correct outcome — rather than becoming a `500`.
 */
function safeNormalise(value: string): string {
  try {
    return normaliseUrl(value);
  } catch {
    return value.trim().toLowerCase();
  }
}
