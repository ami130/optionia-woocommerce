import { Column, Entity, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { moneyTransformer } from '../../common/money/money.transformer';
import { Store } from '../../stores/entities/store.entity';

/**
 * An order fact, reported by the plugin for analytics.
 *
 * The unique constraint on `(storeId, externalOrderId)` is the idempotency
 * guarantee: the plugin retries order reporting when the network fails, and a
 * retry must not double-count revenue.
 */
@Entity('order_events')
@Unique('uq_order_events_external', ['storeId', 'externalOrderId'])
export class OrderEvent extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  storeId: string;

  /**
   * `RESTRICT`: these are financial records.
   *
   * Disconnecting a store must not silently take its revenue history with it —
   * a merchant reconnecting later, or an accountant asking about last quarter,
   * both depend on these rows surviving.
   */
  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Column({ type: 'varchar', length: 64 })
  externalOrderId: string;

  @Column({ type: 'bigint', transformer: moneyTransformer })
  orderTotalMinor: number;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** The portion attributable to options — the number this product is sold on. */
  @Column({ type: 'bigint', default: 0, transformer: moneyTransformer })
  optionRevenueMinor: number;

  @Column({ type: 'datetime', precision: 3 })
  occurredAt: Date;

  @Column({ type: 'json', nullable: true })
  raw: Record<string, unknown> | null;
}
