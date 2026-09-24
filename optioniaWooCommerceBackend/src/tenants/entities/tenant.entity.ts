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

  /**
   * Where this tenant is, for tax (B9, G10).
   *
   * 🔴 **A tax engine cannot compute VAT without one**, and this entity had no
   * country, address or VAT number at all — so the recommended Stripe Tax had
   * nothing to key on.
   *
   * ⚠️ **Nullable because a free tenant has no billing identity and is not asked
   * for one.** B9 collects it at first paid checkout rather than at signup,
   * which keeps a tax form off the registration form that M22.6's *"genuinely
   * useful"* free tier depends on. A `NOT NULL` default would invent a tax
   * location for every existing tenant, which is worse than having none.
   *
   * ISO 3166-1 alpha-2: the length is the validation, and a longer column would
   * invite country *names*, which no tax engine accepts.
   */
  @Column({ type: 'char', length: 2, nullable: true })
  country: string | null;

  /** EU B2B applies the reverse charge on a valid id, so it is stored, not derived. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  vatNumber: string | null;

  /**
   * What this tenant is billed in (G9).
   *
   * 📌 **On the tenant, not the subscription**: a subscription is denominated
   * once, and a currency that changed under a merchant mid-term would make two
   * invoices in one year incomparable.
   */
  @Column({ type: 'char', length: 3, nullable: true })
  billingCurrency: string | null;
}
