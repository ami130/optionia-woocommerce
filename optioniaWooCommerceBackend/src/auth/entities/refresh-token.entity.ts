import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One issued refresh token.
 *
 * **Why this table exists at all.** A stateless JWT cannot be detected as
 * replayed: it carries only what was signed at issue time, and nothing about it
 * changes when it is presented. M6.1 requires reuse detection, so the fact that a
 * token has already been spent has to live somewhere the server can read.
 *
 * **Rotation.** Every refresh mints a new row and marks this one `rotatedAt`,
 * linking the replacement through `replacedById`. The chain of rows from one
 * login is a *family*, joined by `familyId`.
 *
 * **Reuse detection.** A token that hashes to a row already carrying `rotatedAt`
 * was presented twice. The honest interpretation is that a copy was stolen — the
 * legitimate holder has the newer token, so whoever sent the old one is not them.
 * The response is to revoke the entire family, not just this row: the thief may
 * be holding the newest token, and revoking only the replayed one would log out
 * the victim while leaving the attacker signed in.
 */
@Entity('refresh_tokens')
@Index('ix_refresh_tokens_hash', ['tokenHash'], { unique: true })
@Index('ix_refresh_tokens_family', ['familyId'])
@Index('ix_refresh_tokens_user', ['userId'])
export class RefreshToken extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * SHA-256 of the token. The plaintext is returned once and never stored.
   *
   * Unique, because two rows with the same hash would make reuse detection
   * ambiguous — the lookup must identify exactly one issuance.
   *
   * Not bcrypt: this value is high-entropy and random, so there is nothing to
   * brute-force, and refresh happens on every session where a work factor would
   * be paid for nothing.
   */
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  /**
   * All tokens descended from one login share this.
   *
   * Reuse revokes by family, so a stolen token cannot be traded for a fresh one
   * that outlives the revocation.
   */
  @Column({ type: 'char', length: 36 })
  familyId: string;

  /**
   * Set when this token is exchanged. Its presence is what makes a second
   * presentation detectable.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  rotatedAt: Date | null;

  /** The token minted when this one was rotated. Null until then. */
  @Column({ type: 'char', length: 36, nullable: true })
  replacedById: string | null;

  /**
   * Set on logout, on reuse detection, or on password change.
   *
   * Distinct from `rotatedAt`: a rotated token was spent legitimately, a revoked
   * one must never be honoured again.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;

  /** Why it was revoked — 'logout', 'reuse_detected', 'password_changed'. */
  @Column({ type: 'varchar', length: 40, default: '' })
  revokedReason: string;

  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;

  /**
   * Where the token was issued. Shown in "your active sessions" and in the
   * notice sent when a family is revoked, so a merchant can recognise a session
   * that is not theirs.
   */
  @Column({ type: 'varchar', length: 45, default: '' })
  ip: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  userAgent: string;
}
