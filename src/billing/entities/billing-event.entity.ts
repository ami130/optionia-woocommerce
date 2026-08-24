import { Column, Entity, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';

/**
 * A provider webhook, recorded before it is acted on.
 *
 * Global rather than tenant-scoped: a webhook arrives before the tenant is
 * resolved, and must be recorded even when resolution fails — otherwise a
 * mis-routed event vanishes with no trace of why.
 */
@Entity('billing_events')
@Unique('uq_billing_events_provider_event', ['provider', 'providerEventId'])
export class BillingEvent extends BaseEntity {
  @Column({ type: 'varchar', length: 32 })
  provider: string;

  /**
   * The provider's own event id.
   *
   * **The unique constraint here is the idempotency guarantee for Phase 23.**
   * Providers retry webhooks on any non-2xx, and duplicate delivery is normal —
   * a repeat must be a no-op rather than a second charge or a second upgrade.
   */
  @Column({ type: 'varchar', length: 128 })
  providerEventId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  /** Null until handled. Non-null means the effect has been applied exactly once. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  processedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
