import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * Rate limiting keyed on the account, not only the caller.
 *
 * The global throttler keys on IP, which stops one machine hammering an endpoint
 * and does nothing about the attack that actually matters here: credential
 * stuffing distributed across many addresses, each making a handful of attempts
 * against a *different* account. Every one of those stays under a per-IP limit.
 *
 * This guard keys on the submitted email as well, so a single account cannot be
 * attacked faster than its own budget regardless of how many machines are trying.
 *
 * The email is **hashed** before becoming a key. Rate-limit keys end up in memory
 * dumps, and in Redis once M34 replaces the in-memory store — an address is
 * personal data and does not belong there in plaintext.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const ip = req.ip ?? 'unknown';

    /**
     * A store credential keys on the credential itself, not the address.
     *
     * The contract sets the heartbeat at 60 per hour **per store**, and an IP key
     * cannot express that: an agency running fifty shops on one server would give
     * all fifty a single shared budget, so a busy neighbour throttles a quiet one.
     * Keying per store also removes the reverse hole, where one store spread
     * across changing addresses never meets its limit.
     *
     * **Keyed on the presented token's hash rather than the store id**, because
     * this guard runs *before* `StoreTokenGuard` — the global throttler is
     * ordered ahead of authentication so an unauthenticated flood is rejected
     * before it costs a database lookup, which means `storeId` is not yet in
     * context here. The hash identifies the credential without a query, and a
     * credential belongs to exactly one store, so the two are equivalent for
     * rate-limiting purposes.
     *
     * A rotated credential starts a fresh budget. That is correct: rotation is a
     * deliberate, capability-gated act, not something an attacker can trigger.
     *
     * Hashed for the same reason the email is — rate-limit keys reach memory
     * dumps and Redis, and a plaintext credential there is the credential.
     */
    const storeToken = storeCredential(req);

    if (storeToken) {
      return `store:${createHash('sha256').update(storeToken).digest('hex').slice(0, 32)}`;
    }

    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!email) {
      return ip;
    }

    // Both parts: an attacker with many IPs is caught by the account half, and an
    // attacker cycling addresses from one machine is caught by the IP half.
    return `${ip}:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
  }
}

/**
 * The bearer token on a store-realm request, or an empty string.
 *
 * Recognises the realm by the route prefix rather than by inspecting the token:
 * a store credential and a tenant JWT are both opaque strings in the same header,
 * and guessing which is which from their shape would key a merchant's JWT into
 * the store bucket the first time a token happened to parse the wrong way.
 * `/store/*` is the realm boundary the contract draws, so it is the one this
 * follows.
 */
function storeCredential(req: Request): string {
  // `originalUrl` rather than `path`: the global prefix is `/v1`, and `path` on
  // the Express request has not had it stripped in the guard layer either way —
  // matching on the segment is what makes this independent of both.
  if (!/^\/v1\/store(\/|$)/.test(req.originalUrl.split('?')[0] ?? '')) {
    return '';
  }

  const header = req.headers.authorization ?? '';
  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value : '';
}
