import { Column, Entity, Index } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';

/**
 * An address that must not be mailed again.
 *
 * **Sending to a known-bad address damages everyone else's mail.** Providers
 * score a sender on bounce and complaint rates, so continuing to mail an address
 * that hard-bounced degrades delivery for merchants who *are* reachable. The
 * suppression list is what makes that impossible rather than merely discouraged.
 *
 * Keyed on the address rather than the user: a person who unsubscribes or
 * complains has made a decision about the address, and it must hold even if they
 * later register a second account with it.
 *
 * **Not yet fed.** SMTP has no delivery webhook (D4), so nothing writes a
 * `bounce` row today. The table exists now because the `Mailer` must consult it
 * from the first send — a suppression check retrofitted later is one that was
 * absent for every message sent in between.
 */
@Entity('email_suppressions')
@Index('uq_email_suppressions_email', ['email'], { unique: true })
export class EmailSuppression extends BaseEntity {
  @Column({ type: 'varchar', length: 320 })
  email: string;

  /**
   * `hard_bounce` · `complaint` · `unsubscribe` · `manual`.
   *
   * The reason decides whether it can be lifted. A hard bounce may be cleared if
   * the address starts working; a complaint may not be, because re-mailing
   * someone who reported spam is how a sending domain gets blocked.
   */
  @Column({ type: 'varchar', length: 20 })
  reason: string;

  /** What the provider said, kept verbatim for support and for disputes. */
  @Column({ type: 'varchar', length: 500, default: '' })
  detail: string;

  /**
   * Set when a suppression is deliberately lifted.
   *
   * Kept as a row rather than deleted, so "this address was suppressed and
   * someone cleared it" stays answerable after an incident.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  liftedAt: Date | null;

  @Column({ type: 'char', length: 36, nullable: true })
  liftedByUserId: string | null;
}
