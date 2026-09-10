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
   * Where to push "new configuration is available" (M9.4).
   *
   * A REST route the plugin registers — **not** the handshake's `callback`,
   * which is a browser redirect to an admin screen. A server posting there
   * reaches a login page, not the plugin, and the two are easy to confuse
   * because both are called a callback.
   *
   * Nullable, and stays null for a store connected by a plugin build that
   * predates the route: the push is a latency improvement over M9.3's
   * fifteen-minute pull, so a store without one is behind by minutes rather
   * than broken. 500 characters to match `store_connection_codes.callback`,
   * since both hold a URL a merchant's site chose.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  pushUrl: string | null;

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

  /**
   * Bytes this store reported holding in customer uploads (M15.6).
   *
   * 🔴 **A level, not an accumulator.** `file_storage_mb` is a *tenant* limit,
   * but a tenant may hold ten stores, each with its own uploads table on its own
   * disk. Keeping each store's current figure here is what lets the tenant row in
   * `usage_records` be re-summed rather than overwritten by whichever store
   * happened to check in last.
   *
   * ⚠️ **Null is "never reported", not "holding nothing".** A plugin older than
   * M15.6 sends no field at all, and counting that as zero would quietly shrink a
   * tenant's measured usage the moment one store lagged behind on updates.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  storageBytes: number | null;
}
