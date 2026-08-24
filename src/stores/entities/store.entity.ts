import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { bigintTransformer } from '../../common/database/bigint.transformer';
import { StorePlatform, StoreStatus } from '../../common/database/enums';
import { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * A merchant's connected storefront.
 *
 * `status` is a real state machine (M8.1b), not a boolean. Ambiguous connection
 * state is the largest source of support tickets in this product category: the
 * merchant sees "connected", the cloud disagrees, and nobody can tell which is
 * right.
 */
@Entity('stores')
@Unique('uq_stores_tenant_url', ['tenantId', 'storeUrl'])
@Index('ix_stores_last_seen', ['lastSeenAt'])
export class Store extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  /**
   * `RESTRICT`: deleting a tenant with connected stores must fail loudly.
   *
   * The alternative is quietly disconnecting live storefronts, which a merchant
   * discovers when their options stop rendering.
   */
  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /**
   * WooCommerce is the only value at launch.
   *
   * Modelled as an enum from day one so a second platform is a new adapter
   * rather than a schema migration across every table.
   */
  @Column({ type: 'varchar', length: 20, default: StorePlatform.WOOCOMMERCE })
  platform: StorePlatform;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  storeUrl: string;

  @Column({ type: 'varchar', length: 20, default: StoreStatus.DISCONNECTED })
  status: StoreStatus;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  connectedAt: Date | null;

  /**
   * Updated by the plugin heartbeat.
   *
   * Indexed because stale-install detection scans on it: a store that has not
   * checked in for weeks is a support problem before the merchant reports it.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastSeenAt: Date | null;

  // Reported on heartbeat. The first four questions of any support ticket,
  // answered without asking.
  @Column({ type: 'varchar', length: 20, nullable: true })
  pluginVersion: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  wpVersion: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  wcVersion: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phpVersion: string | null;

  /** Incremented on publish. Drives plugin cache invalidation. */
  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  configVersion: number;
}
