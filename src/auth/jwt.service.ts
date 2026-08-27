import { Injectable } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';

/**
 * Access tokens.
 *
 * Short-lived and **not** revocable — that is the trade. Revocation lives with
 * the refresh token, which is stored and can be killed; an access token is
 * accepted until it expires, which is why it expires in minutes rather than days.
 *
 * **The `aud` claim separates the three identity realms** (M6.5). A token minted
 * for a merchant must not authenticate a platform admin route, and the check
 * happens before any role logic — a cross-realm token is a 401, not a 403,
 * because the route should not admit it exists.
 */

/**
 * The realms that authenticate with a **JWT**.
 *
 * ⚠️ **There is deliberately no `STORE` member.** A store presents an opaque
 * credential checked against `store_credentials`, never a JWT — M8.6 requires
 * revocation to be immediate and a JWT cannot be un-issued. A `STORE` audience
 * existed here from Phase 6 and was used by nothing but a test; keeping it would
 * imply a store token this code could mint, which is the opposite of the
 * decision. Removed in `[8c]`; see ADR-039.
 *
 * `PLATFORM` is unused *today* and stays: it is a genuine JWT audience whose
 * routes arrive in Phase 26. The two are not the same case — one is waiting, the
 * other was wrong.
 */
export const TokenAudience = {
  PLATFORM: 'platform',
  TENANT: 'tenant',
} as const;

export type TokenAudience = (typeof TokenAudience)[keyof typeof TokenAudience];

export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  readonly aud: TokenAudience;
  /**
   * The tenant this token acts within.
   *
   * Present for the tenant realm only. A platform token is deliberately
   * cross-tenant, and a store token identifies a store rather than a person.
   */
  readonly tid?: string;
  readonly role?: string;
  /** Issued-at, in seconds. Set by the library on every token. */
  readonly iat?: number;
}

@Injectable()
export class AuthJwtService {
  /**
   * @param accessTtlSeconds Lifetime in seconds. A number rather than a string
   *   like `15m`: the library's own duration type rejects a plain string, and
   *   parsing once here keeps the unit ambiguity out of every call site — the
   *   same trap that would have made `720h` a two-year refresh token.
   */
  constructor(
    private readonly jwt: NestJwtService,
    private readonly accessTtlSeconds: number,
  ) {}

  /** Mint an access token for a merchant acting within one tenant. */
  signTenantAccess(userId: string, tenantId: string, role: string): string {
    // `aud` and `sub` are registered JWT claims, so they are set through options
    // rather than the payload — passing them in the payload is silently ignored
    // by some libraries and rejected by this one.
    return this.jwt.sign<Record<string, unknown>>(
      { tid: tenantId, role },
      { subject: userId, audience: TokenAudience.TENANT, expiresIn: this.accessTtlSeconds },
    );
  }

  /**
   * Verify a token and confirm it belongs to the expected realm.
   *
   * Returns null on any failure rather than throwing. The caller turns that into
   * one uniform 401 — distinguishing "expired" from "wrong audience" from
   * "signature invalid" tells an attacker which part of their forgery worked.
   */
  verify(token: string, audience: TokenAudience): AccessTokenClaims | null {
    try {
      const claims = this.jwt.verify<AccessTokenClaims>(token, { audience });

      // Belt and braces: `verify` checks the audience, and this makes the
      // guarantee visible at the call site rather than trusting an option.
      return claims.aud === audience ? claims : null;
    } catch {
      return null;
    }
  }
}
