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
