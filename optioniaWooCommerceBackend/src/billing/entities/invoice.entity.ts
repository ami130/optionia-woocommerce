import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { InvoiceStatus } from '../../common/database/enums';
import { moneyTransformer } from '../../common/money/money.transformer';
import { Subscription } from '../../subscriptions/entities/subscription.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * What was charged, and how much of it was tax.
 *
 * 🔴 **A compliance record before it is a feature.** ADR-114 makes ParseLab
 * merchant of record and ADR-115 collects VAT through Stripe Tax, so the
 * question *"what tax did we collect in this quarter, by country?"* must be
 * answerable from this database. Before this table nothing stored a tax amount
 * at all — G3 called invoice history *"an unstated choice"*, and the tax
 * decision turned it into an obligation.
 *
 * ⚠️ **A mirror, not the source of truth.** The provider is authoritative for
 * what was charged; these rows are the queryable copy. Reconciliation (M23.5)
 * compares the two and treats a difference as a **finding**, the same shape as
 * `plan_prices`, where the provider holds the Price and we hold the pin.
 */
@Entity('invoices')
@Unique('uq_invoices_provider_invoice', ['provider', 'providerInvoiceId'])
@Index('ix_invoices_tenant_issued', ['tenantId', 'issuedAt'])
@Index('ix_invoices_tax_period', ['taxCountry', 'issuedAt'])
export class Invoice extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  /** `RESTRICT`: an invoice whose tenant vanished is an unexplainable tax line. */
  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /**
   * ⚠️ **`SET NULL`, unlike the tenant.** A subscription may be removed while
   * its invoices stay reportable: losing the link is acceptable, losing the
   * invoice is not.
   */
  @Column({ type: 'char', length: 36, nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription | null;

  @Column({ type: 'varchar', length: 32 })
  provider: string;

  /**
   * The provider's own invoice id.
   *
   * 🔴 **`UNIQUE (provider, providerInvoiceId)` is the idempotency guarantee**,
   * matching `billing_events`. A webhook is delivered more than once by design,
   * so a repeat must find this row rather than write a second one and double the
   * quarter's reported tax.
   */
  @Column({ type: 'varchar', length: 128 })
  providerInvoiceId: string;

  /**
   * The provider's word, typed (F92/D4).
   *
   * 🔴 **Free text here was a silent tax-reporting hole.** The period report
   * filters `status = 'paid'`; an adapter writing `Paid` or `succeeded` would
   * drop those rows from the total with no error and no failing test.
   */
  @Column({ type: 'varchar', length: 20 })
  status: InvoiceStatus;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'bigint', transformer: moneyTransformer })
  subtotalMinor: number;

  /**
   * 🔴 **Stored, never derived.** A reverse-charge B2B sale has `taxMinor = 0`
   * at a non-zero rate, and a figure recomputed at read time would quietly
   * disagree with what the customer was actually charged — which is the one
   * number a tax return must not guess at.
   */
  @Column({ type: 'bigint', transformer: moneyTransformer })
  taxMinor: number;

  @Column({ type: 'bigint', transformer: moneyTransformer })
  totalMinor: number;

  /**
   * Where the tax was owed, as the provider determined it.
   *
   * 📌 **Copied from the invoice rather than read from the tenant.** A tenant
   * may move; an invoice was taxed where the customer was *at the time*, and a
   * return for a past period must reflect that rather than today's address.
   */
  @Column({ type: 'char', length: 2, nullable: true })
  taxCountry: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  issuedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  paidAt: Date | null;

  /** The provider's hosted copy, which is what a merchant is shown (M22.5). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  hostedUrl: string | null;
}
