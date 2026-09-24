import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { SubscriptionStatus } from '../../common/database/enums';
import { Plan } from '../../plans/entities/plan.entity';
import { PlanPrice } from '../../plans/entities/plan-price.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * A tenant's subscription.
 *
 * State is updated **only** from verified provider webhooks, never from a
 * browser redirect — a success page proves the customer reached it, not that
 * payment settled.
 */
@Entity('subscriptions')
@Index('ix_subscriptions_provider', ['provider', 'providerSubscriptionId'])
export class Subscription extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  /** `RESTRICT`: deleting a tenant with a live subscription must be deliberate. */
  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ type: 'char', length: 36 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'planId' })
  plan: Plan;

  /**
   * A plain string rather than an enum.
   *
   * D1 — which billing provider — is still open, and keeping this untyped means
   * either answer fits without a migration.
   */
  @Column({ type: 'varchar', length: 32 })
  provider: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  providerSubscriptionId: string | null;

  /**
   * The provider's **customer**, which is not the subscription (G7).
   *
   * 🔴 **A billing portal session, a saved payment method and invoice history
   * all key on the customer.** With only `providerSubscriptionId` there is
   * nothing to open a portal with — so M22.5's *"payment method management"*
   * had no call to make.
   *
   * ⚠️ **It outlives any one subscription.** A merchant who cancels and returns
   * is the same customer with the same cards and the same invoice history;
   * storing it on the subscription alone would lose that on cancellation, so a
   * later step moves it to the tenant if a second subscription ever needs it.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerCustomerId: string | null;

  /**
   * The exact price this subscription bought, pinned (G1).
   *
   * 🔴 **This is what stops a plan edit re-pricing an existing subscriber.**
   * `planId` still points at a mutable row and is what the *plan* means —
   * limits, name, position. What the merchant **pays** is this row, and it is
   * immutable.
   *
   * ⚠️ **Nullable, and both reasons are real states rather than missing data**:
   * every subscription predating versioning has none, and a free subscription
   * has no price at all.
   */
  @Column({ type: 'char', length: 36, nullable: true })
  planPriceId: string | null;

  @ManyToOne(() => PlanPrice, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'planPriceId' })
  planPrice: PlanPrice | null;

  @Column({ type: 'varchar', length: 20, default: SubscriptionStatus.TRIALING })
  status: SubscriptionStatus;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  currentPeriodEnd: Date | null;

  /**
   * When the grace period ends after a failed payment.
   *
   * The lapse policy (M24.3) keeps storefronts working throughout: breaking a
   * merchant's live store over a failed card is how a SaaS earns a permanent
   * reputation problem.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  graceEndsAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  cancelAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  trialEndsAt: Date | null;
}
