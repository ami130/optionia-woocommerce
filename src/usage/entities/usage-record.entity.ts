import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { bigintTransformer } from '../../common/database/bigint.transformer';
import { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * Metered usage against plan limits.
 *
 * One row per tenant per metric per period. Every key in `plans.limits` has a
 * counter here — a limit that cannot be measured cannot be sold.
 */
@Entity('usage_records')
/*
 * ⚠️ **Unique, so the write can be atomic.** Without it an upsert is a `SELECT`
 * then an `INSERT`, and two stores of one tenant heartbeating together both find
 * nothing and both insert. A business-plan tenant has ten stores checking in
 * daily, so that race is routine rather than theoretical.
 */
@Index('uq_usage_tenant_metric', ['tenantId', 'metric', 'periodStart'], { unique: true })
export class UsageRecord extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /** e.g. `option_sets`, `products_assigned`, `file_storage_mb`, `team_seats`. */
  @Column({ type: 'varchar', length: 40 })
  metric: string;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  value: number;

  @Column({ type: 'datetime', precision: 3 })
  periodStart: Date;

  @Column({ type: 'datetime', precision: 3 })
  periodEnd: Date;
}
