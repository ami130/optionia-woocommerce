import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { moneyTransformer } from '../../common/money/money.transformer';
import { Store } from '../../stores/entities/store.entity';

/**
 * A mirror of the merchant's catalogue, for the product picker.
 *
 * **Never a source of truth.** `priceMinor` is display-only — the plugin always
 * uses WooCommerce's live price, because a cached price shown at checkout would
 * be a customer charged the wrong amount.
 *
 * Hard-deleted rather than soft (ADR-014): a product removed in WooCommerce
 * should vanish here, and reconciliation rebuilds it if that was wrong.
 */
@Entity('store_products')
@Unique('uq_store_products_external', ['storeId', 'externalId'])
@Index('ix_store_products_search', ['storeId', 'name'])
export class StoreProduct extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  storeId: string;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  /** The WooCommerce product id. Unique per store, not globally. */
  @Column({ type: 'varchar', length: 64 })
  externalId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sku: string | null;

  /** simple · variable · grouped · external — each renders differently (M10.5). */
  @Column({ type: 'varchar', length: 20 })
  type: string;

  @Column({ type: 'bigint', nullable: true, transformer: moneyTransformer })
  priceMinor: number | null;

  @Column({ type: 'varchar', length: 20 })
  status: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  permalink: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  @Column({ type: 'json', nullable: true })
  categories: string[] | null;

  @Column({ type: 'json', nullable: true })
  tags: string[] | null;

  @Column({ type: 'datetime', precision: 3 })
  syncedAt: Date;

  /** WooCommerce's own modified time, for reconciliation diffs. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  externalUpdatedAt: Date | null;
}
