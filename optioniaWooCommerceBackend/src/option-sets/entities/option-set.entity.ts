import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { bigintTransformer } from '../../common/database/bigint.transformer';
import { OptionSetStatus } from '../../common/database/enums';
import { Store } from '../../stores/entities/store.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * A collection of option groups a merchant assigns to products.
 *
 * Holds a published version and a working draft simultaneously, so a merchant
 * can edit safely on a live store — the thing a self-hosted plugin cannot offer.
 * An edit does not reach storefronts until publish.
 */
@Entity('option_sets')
@Index('ix_option_sets_store_status', ['storeId', 'status', 'deletedAt'])
export class OptionSet extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ type: 'char', length: 36 })
  storeId: string;

  /** `CASCADE`: once a store is genuinely gone, its sets have nothing to render on. */
  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 20, default: OptionSetStatus.DRAFT })
  status: OptionSetStatus;

  /** Incremented on publish. Snapshotted into `option_set_versions`. */
  @Column({ type: 'int', default: 0 })
  version: number;

  /**
   * Optimistic lock (M7.4b).
   *
   * Two people editing one set is normal in an agency. Every write carries the
   * version the client loaded, and a mismatch is a 409 with the current state —
   * never a silent last-write-wins. Losing an afternoon's work to a colleague's
   * save is unforgivable in an authoring tool.
   */
  @Column({ type: 'int', default: 0 })
  rowVersion: number;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'char', length: 36, nullable: true })
  publishedBy: string | null;

  /** Config version this set was last published into. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  publishedConfigVersion: number;
}
