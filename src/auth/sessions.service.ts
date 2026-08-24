import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';

import { generateToken, hasExpired, hashToken } from '../common/crypto/tokens';
import { RefreshToken } from './entities/refresh-token.entity';

/**
 * Refresh token issuance, rotation, and reuse detection.
 *
 * **The security property this exists for:** a refresh token presented twice
 * means a copy was stolen. The legitimate holder has the replacement, so whoever
 * sent the spent one is not them.
 *
 * The response is to revoke the whole family. Revoking only the replayed row
 * would log the victim out while leaving the attacker signed in with the newest
 * token — the exact inverse of what is wanted.
 */

/** Why a refresh attempt failed. Callers translate this into a response. */
export type RefreshFailure = 'not_found' | 'expired' | 'revoked' | 'reused';

export interface RefreshOutcome {
  readonly token: string | null;
  readonly userId: string | null;
  readonly failure: RefreshFailure | null;
}

/** Reasons recorded on `revokedReason`, kept short and stable for querying. */
export const RevokeReason = {
  LOGOUT: 'logout',
  REUSE_DETECTED: 'reuse_detected',
  PASSWORD_CHANGED: 'password_changed',
} as const;

/**
 * Convert a duration like `30d`, `720h` or `45m` into milliseconds.
 *
 * `parseInt('30d')` happens to give 30, which is correct only because the unit
 * is days. `parseInt('720h')` gives 720, and treating that as days makes a
 * refresh token last two years — a silent, enormous change from a value that
 * looks like a tightening.
 */
export function parseDuration(value: string, fallbackMs: number): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());

  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  const multiplier =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;

  return amount > 0 ? amount * multiplier : fallbackMs;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    private readonly refreshTtlMs: number,
  ) {}

  /**
   * Start a new session.
   *
   * Each login opens its own family, so signing out of one device cannot end a
   * session on another.
   */
  async issue(userId: string, ip: string, userAgent: string): Promise<string> {
    const token = generateToken();

    await this.tokens.save(
      this.tokens.create({
        userId,
        tokenHash: token.hash,
        familyId: randomUUID(),
        expiresAt: this.expiry(),
        ip: ip.slice(0, 45),
        userAgent: userAgent.slice(0, 255),
      }),
    );

    return token.plaintext;
  }

  /**
   * Exchange a refresh token for a new one.
   *
   * The old row is marked `rotatedAt` and linked to its replacement, which is
   * what makes a second presentation detectable at all.
   */
  async rotate(plaintext: string, ip: string, userAgent: string): Promise<RefreshOutcome> {
    const current = await this.tokens.findOne({ where: { tokenHash: hashToken(plaintext) } });

    if (current === null) {
      return { token: null, userId: null, failure: 'not_found' };
    }

    if (current.revokedAt !== null) {
      return { token: null, userId: null, failure: 'revoked' };
    }

    // Presented after it was already exchanged. Someone has a copy.
    if (current.rotatedAt !== null) {
      await this.revokeFamily(current.familyId, RevokeReason.REUSE_DETECTED);

      this.logger.warn(
        `refresh token reuse detected for user ${current.userId}; ` +
          `revoked family ${current.familyId}`,
      );

      return { token: null, userId: current.userId, failure: 'reused' };
    }

    if (hasExpired(current.expiresAt)) {
      return { token: null, userId: null, failure: 'expired' };
    }

    const next = generateToken();

    const replacement = await this.tokens.save(
      this.tokens.create({
        userId: current.userId,
        tokenHash: next.hash,
        // Same family: this is the same session continuing.
        familyId: current.familyId,
        expiresAt: this.expiry(),
        ip: ip.slice(0, 45),
        userAgent: userAgent.slice(0, 255),
      }),
    );

    current.rotatedAt = new Date();
    current.replacedById = replacement.id;
    await this.tokens.save(current);

    return { token: next.plaintext, userId: current.userId, failure: null };
  }

  /**
   * End one session.
   *
   * Revokes the family rather than the row, so a token already rotated out
   * cannot be used to continue after a logout.
   */
  async revoke(plaintext: string): Promise<boolean> {
    const row = await this.tokens.findOne({ where: { tokenHash: hashToken(plaintext) } });

    if (row === null) {
      return false;
    }

    await this.revokeFamily(row.familyId, RevokeReason.LOGOUT);

    return true;
  }

  /**
   * End every session for a user.
   *
   * Called after a password change: whoever knew the old password may still hold
   * a refresh token, and changing the password has to be enough to lock them out.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.tokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Revoke every live token in one family. */
  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.tokens.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  private expiry(): Date {
    return new Date(Date.now() + this.refreshTtlMs);
  }
}
