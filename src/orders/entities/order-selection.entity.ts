import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { bigintTransformer } from '../../common/database/bigint.transformer';
import { moneyTransformer } from '../../common/money/money.transformer';
import { OrderEvent } from './order-event.entity';

/**
 * What a customer actually selected, as a historical fact.
 *
 * ⚠️ **No foreign key to `options` or `option_values`, deliberately** (ADR-016).
 *
 * Phase 4 proved the failure this prevents: an option was deleted from
 * configuration while it sat in a cart, and checkout completed — order #32
 * charged $100 for "Finish: Luxury" after that option no longer existed. An
 * order is a historical fact and does not change because configuration later
 * did. A foreign key would either block the deletion or cascade the order
 * record away, and both are wrong.
 *
 * ⚠️ **May contain personal data.** An engraving message, a gift note, a name.
 * Therefore **hard-erased** on a GDPR request, never soft-deleted (ADR-014).
 */
@Entity('order_selections')
@Index('ix_order_selections_event', ['orderEventId'])
@Index('ix_order_selections_analytics', ['optionKey', 'valueKey'])
export class OrderSelection extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  orderEventId: string;

  @ManyToOne(() => OrderEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderEventId' })
  orderEvent: OrderEvent;

  /** Denormalized. Survives the option row's deletion. */
  @Column({ type: 'varchar', length: 64 })
  optionKey: string;

  /**
   * Snapshotted at order time.
   *
   * A merchant renaming "Luxury" to "Premium" must not rewrite what a past
   * customer saw on their receipt.
   */
  @Column({ type: 'varchar', length: 200 })
  optionLabel: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  valueKey: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  valueLabel: string | null;

  @Column({ type: 'bigint', default: 0, transformer: moneyTransformer })
  priceDeltaMinor: number;

  /**
   * The config version this line was priced against.
   *
   * Makes the stored delta auditable: a later dispute or refund can be reasoned
   * about against the configuration that actually applied.
   */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  configVersion: number;
}
