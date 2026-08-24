import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { expiresIn, generateToken, hasExpired, hashToken } from '../common/crypto/tokens';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';

/**
 * Issue and redeem the single-use link tokens.
 *
 * Both flows share one shape — mint, mail, redeem once — so they share one
 * implementation. The alternative is two near-identical services where a fix to
 * one silently misses the other.
 */

/** 24 hours. Long enough to survive a mail delay and a night's sleep. */
export const VERIFICATION_TTL_MINUTES = 24 * 60;

/**
 * 30 minutes.
 *
 * Much shorter than verification because this token *is* an account takeover.
 * The cost of it being too short is a second click on "forgot password"; the cost
 * of it being too long is a link sitting readable in a mailbox someone else can
 * reach.
 */
export const RESET_TTL_MINUTES = 30;

/** Why a redemption failed. Callers translate this into a response. */
export type RedemptionFailure = 'not_found' | 'expired' | 'already_used';

export interface RedemptionResult<T> {
  readonly token: T | null;
  readonly failure: RedemptionFailure | null;
}

@Injectable()
export class AuthTokensService {
  constructor(
    @InjectRepository(EmailVerificationToken)
    private readonly verifications: Repository<EmailVerificationToken>,
    @InjectRepository(PasswordResetToken)
    private readonly resets: Repository<PasswordResetToken>,
  ) {}

  /**
   * Mint a verification token for an address.
   *
   * Any outstanding token for the same user is consumed first. Without that, a
   * merchant who clicks "resend" three times leaves three working links, and the
   * two they abandoned stay valid for a day.
   */
  async issueVerification(userId: string, email: string): Promise<string> {
    // `IsNull()`, not `null`. TypeORM renders a bare null as `= NULL`, which is
    // never true in SQL — the update would match nothing and every resend would
    // leave the previous link working.
    await this.verifications.update(
      { userId, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );

    const token = generateToken();

    await this.verifications.save(
      this.verifications.create({
        userId,
        email,
        tokenHash: token.hash,
        expiresAt: expiresIn(VERIFICATION_TTL_MINUTES),
      }),
    );

    return token.plaintext;
  }

  /** Redeem a verification token, or explain why it cannot be redeemed. */
  async redeemVerification(
    plaintext: string,
  ): Promise<RedemptionResult<EmailVerificationToken>> {
    const row = await this.verifications.findOne({
      where: { tokenHash: hashToken(plaintext) },
    });

    const failure = failureFor(row);

    if (failure !== null || row === null) {
      return { token: null, failure: failure ?? 'not_found' };
    }

    row.consumedAt = new Date();
    await this.verifications.save(row);

    return { token: row, failure: null };
  }

  /**
   * Mint a password reset token.
   *
   * Outstanding tokens are consumed for the same reason as verification, and one
   * more: two concurrent requests would otherwise leave a second working link
   * after the first is used, which is a live takeover vector rather than a
   * nuisance.
   */
  async issueReset(userId: string, ip: string, userAgent: string): Promise<string> {
    await this.resets.update({ userId, consumedAt: IsNull() }, { consumedAt: new Date() });

    const token = generateToken();

    await this.resets.save(
      this.resets.create({
        userId,
        tokenHash: token.hash,
        expiresAt: expiresIn(RESET_TTL_MINUTES),
        ip: ip.slice(0, 45),
        userAgent: userAgent.slice(0, 255),
      }),
    );

    return token.plaintext;
  }

  async redeemReset(plaintext: string): Promise<RedemptionResult<PasswordResetToken>> {
    const row = await this.resets.findOne({ where: { tokenHash: hashToken(plaintext) } });

    const failure = failureFor(row);

    if (failure !== null || row === null) {
      return { token: null, failure: failure ?? 'not_found' };
    }

    row.consumedAt = new Date();
    await this.resets.save(row);

    return { token: row, failure: null };
  }

  /**
   * Invalidate every outstanding reset token for a user.
   *
   * Called after a successful password change, so a link minted before the change
   * cannot be used to undo it.
   */
  async revokeResets(userId: string): Promise<void> {
    await this.resets.update({ userId, consumedAt: IsNull() }, { consumedAt: new Date() });
  }
}

/**
 * Why this row cannot be redeemed, or null if it can.
 *
 * Order matters: a token that is both expired and used reports `already_used`,
 * because that is the more specific fact and the one a support conversation turns
 * on.
 */
function failureFor(
  row: { consumedAt: Date | null; expiresAt: Date } | null,
): RedemptionFailure | null {
  if (row === null) {
    return 'not_found';
  }

  if (row.consumedAt !== null) {
    return 'already_used';
  }

  if (hasExpired(row.expiresAt)) {
    return 'expired';
  }

  return null;
}
