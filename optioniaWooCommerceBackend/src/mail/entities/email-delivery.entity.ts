import { Column, Entity, Index } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';

/**
 * One attempt to send one message.
 *
 * **The question this table answers is "did they get it?"** — which support is
 * asked constantly and cannot answer from a provider dashboard alone, because the
 * dashboard does not know which tenant or which flow a message belonged to.
 *
 * **Deliberately not tenant-scoped by foreign key.** Some mail predates any
 * tenant: a verification email is sent before provisioning completes, and a
 * password reset for a user who belongs to several tenants belongs to none of
 * them. `tenantId` is therefore a nullable reference *without* a constraint, so a
 * tenant deletion cannot orphan or cascade away the delivery history that proves
 * what was sent.
 *
 * **Status is only as good as the transport.** SMTP reports handoff to the
 * relay, not delivery to the inbox, so `sent` is the terminal state today. The
 * `bounced` and `complained` states exist because the schema should not need
 * migrating when a provider with webhooks replaces SMTP (D4) — they are simply
 * never written yet.
 */
@Entity('email_deliveries')
@Index('ix_email_deliveries_recipient', ['recipient'])
@Index('ix_email_deliveries_tenant', ['tenantId'])
@Index('ix_email_deliveries_template', ['template', 'createdAt'])
export class EmailDelivery extends BaseEntity {
  /**
   * Nullable and unconstrained by design — see the class comment. Verification
   * mail exists before the tenant does.
   */
  @Column({ type: 'char', length: 36, nullable: true })
  tenantId: string | null;

  /** Nullable for the same reason: a reset is requested by address, not session. */
  @Column({ type: 'char', length: 36, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 320 })
  recipient: string;

  /** Template key, e.g. `verify-email`. Indexed with `createdAt` so "how many
   * invitations went out last week" does not scan the table. */
  @Column({ type: 'varchar', length: 64 })
  template: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  subject: string;

  /**
   * `queued` · `sent` · `failed` · `bounced` · `complained`.
   *
   * A varchar rather than a MySQL ENUM, consistent with the rest of the schema:
   * adding a state should be a deploy, not an ALTER on a growing table.
   */
  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status: string;

  /**
   * The provider's own identifier, when there is one.
   *
   * Empty under SMTP. It is what a future webhook matches on to move a row to
   * `bounced`, so it is recorded from the first send rather than added later.
   */
  @Column({ type: 'varchar', length: 128, default: '' })
  providerMessageId: string;

  /** Populated on `failed` — the transport error, for support and for retry. */
  @Column({ type: 'varchar', length: 500, default: '' })
  error: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempts: number;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  sentAt: Date | null;
}
