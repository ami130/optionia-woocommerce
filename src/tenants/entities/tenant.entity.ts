import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { TenantStatus } from '../../common/database/enums';
import { Plan } from '../../plans/entities/plan.entity';

/**
 * A merchant account. The root of tenant scoping.
 *
 * Every tenant-scoped table reaches this either directly through `tenant_id` or
 * through a foreign-key path, which is what makes the scoped repository (M6.4)
 * able to refuse a query with no tenant context.
 */
@Entity('tenants')
export class Tenant extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Used in URLs. Immutable in practice — changing it breaks merchant links. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'varchar', length: 20, default: TenantStatus.ACTIVE })
  status: TenantStatus;

  @Column({ type: 'char', length: 36 })
  planId: string;

  /**
   * `RESTRICT`: a plan with tenants on it cannot be deleted.
   *
   * Deleting a plan out from under a paying merchant would leave a subscription
   * pointing at nothing, so the plan must be migrated off first.
   */
  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'planId' })
  plan: Plan;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  trialEndsAt: Date | null;
}
