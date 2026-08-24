import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A single-use link proving control of an email address.
 *
 * **Hashed, like every other token here.** A verification link grants the ability
 * to activate an account, so a database read must not yield a working link.
 *
 * **Also used for email changes**, which is why `email` is stored rather than
 * read from the user row: changing an address must verify the *new* one before it
 * replaces the old, and until then the user record still holds the previous
 * address.
 */
@Entity('email_verification_tokens')
@Index('ix_email_verification_tokens_hash', ['tokenHash'], { unique: true })
@Index('ix_email_verification_tokens_user', ['userId'])
export class EmailVerificationToken extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** SHA-256 of the token in the link. */
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  /**
   * The address being proven.
   *
   * For a new registration this matches the user's address. For an email change
   * it is the incoming one, which is not yet on the user record.
   */
  @Column({ type: 'varchar', length: 320 })
  email: string;

  /**
   * Set on redemption. Single-use is enforced here rather than by deleting the
   * row, so a second click can say "already verified" instead of "invalid link" —
   * a distinction that matters when a mail client pre-fetches the link.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  consumedAt: Date | null;

  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;
}
