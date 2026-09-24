import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { moneyTransformer } from '../../common/money/money.transformer';
import { Plan } from './plan.entity';

/**
 * One immutable price for a plan. Editing writes a new row; nothing rewrites one.
 *
 * ## The defect this exists to prevent
 *
 * 🔴 **Plans are editable by decision (M22.1a), and `subscriptions.planId`
 * points straight at that mutable row.** So changing a plan's price today would
 * change what **every existing subscriber on it pays** — including merchants who
 * signed up under different terms, who would find out on a card statement. That
 * is the most expensive kind of billing error: silent, retroactive, and
 * discovered by the customer rather than by us.
 *
 * ⚠️ **A version, not a history table.** The distinction matters: a history
 * table records what *was* true and is read by nobody at runtime. These rows are
 * live — a subscription is **pinned** to the one it bought, and that row is what
 * its renewal is charged against for as long as it lasts.
 *
 * 📌 **Stripe models prices exactly this way**, for the same reason. Matching it
 * keeps the provider mapping honest: a `plan_prices` row maps to one Stripe
 * Price, and `providerPriceId` is where that link lives rather than in a lookup
 * nobody maintains.
 *
 * ## Retired, never deleted
 *
 * `retiredAt` rather than a delete, and `RESTRICT` on the foreign key: an old
 * invoice was priced by this row, and a price a subscription is pinned to must
 * not vanish underneath it. `isCurrent` is what a signup reads; `retiredAt` is
 * what an auditor reads.
 */
@Entity('plan_prices')
export class PlanPrice extends BaseEntity {
  @Index('ix_plan_prices_current', ['planId', 'currency', 'interval', 'isCurrent'])
  @Column({ type: 'char', length: 36 })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'planId' })
  plan: Plan;

  /** ISO 4217, matching `plans.currency`. Multi-currency is rows, not columns (G9). */
  @Column({ type: 'char', length: 3 })
  currency: string;

  /**
   * `month` or `year`.
   *
   * ⚠️ **A column rather than two amount fields**, unlike `plans`, which carries
   * `priceMonthlyMinor` and `priceYearlyMinor` side by side. A row per interval
   * is what lets a yearly price be retired without touching the monthly one —
   * which two columns on one row cannot express.
   */
  @Column({ type: 'varchar', length: 10 })
  interval: string;

  /**
   * Minor units, `bigint`, through the same transformer as every other money
   * column here. 🔴 **Never `decimal`**: a second money representation is how
   * rounding disagreements start, and a billing schema is the worst place to
   * have two.
   */
  @Column({ type: 'bigint', transformer: moneyTransformer })
  amountMinor: number;

  /** The provider's id for this exact price. Null until it has been created there. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerPriceId: string | null;

  /** What a new signup is offered. At most one per plan/currency/interval. */
  @Column({ type: 'boolean', default: true })
  isCurrent: boolean;

  /** When it stopped being offered. Subscriptions pinned to it are unaffected. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  retiredAt: Date | null;
}
