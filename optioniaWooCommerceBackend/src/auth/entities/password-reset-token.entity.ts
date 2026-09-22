import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A single-use link permitting a password change without the old password.
 *
 * The most dangerous token in the system: it is a complete account takeover in
 * one URL. Hashed at rest, short-lived, single-use, and invalidated by a
 * successful reset of any outstanding token for the same user — otherwise two
 * concurrent requests leave a second working link after the first is used.
 *
 * **Requesting a reset must not reveal whether an address is registered**
 * (M6.1), so the endpoint responds identically either way and simply creates no
 * row when there is no user.
 */
@Entity('password_reset_tokens')
@Index('ix_password_reset_tokens_hash', ['tokenHash'], { unique: true })
@Index('ix_password_reset_tokens_user', ['userId'])
export class PasswordResetToken extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** SHA-256 of the token in the link. */
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  consumedAt: Date | null;

  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;

  /**
   * Where the reset was requested from, recorded for the notification sent after
   * a successful change — "your password was changed from this location" is how
   * a victim learns of a takeover.
   */
  @Column({ type: 'varchar', length: 45, default: '' })
  ip: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  userAgent: string;
}
