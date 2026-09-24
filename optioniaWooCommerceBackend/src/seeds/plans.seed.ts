import type { DataSource } from 'typeorm';

import { AuditLog } from '../audit/entities/audit-log.entity';
import { Plan } from '../plans/entities/plan.entity';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { report } from './seed-context';

/**
 * Subscription plans.
 *
 * ⚠️ **These limits are PROVISIONAL.**
 *
 * D2 — the free tier shape — is an open decision (ADR-005). It is not an
 * engineering choice: it depends on the competitive teardown and on what beta
 * merchants actually balk at, neither of which has happened. Deciding it today
 * would be guessing, and a guess recorded as a decision is worse than a
 * placeholder that says so.
 *
 * They are seeded rather than left null because Phase 24 builds limit
 * enforcement, and enforcement needs limits to enforce. Null would short-circuit
 * every check, so the code paths would never run and their tests would prove
 * nothing.
 *
 * Deferring is cheap by design: `limits` is a JSON column, so changing these is
 * an `UPDATE` rather than a migration.
 *
 * **Phase 22 must reconcile these against the live pricing page**, which
 * currently advertises "All Option Types (30+)" and "Edit Options in Cart" —
 * neither of which is in MVP scope (M1.6).
 */
interface PlanSeed {
  code: string;
  name: string;
  priceMonthlyMinor: number;
  priceYearlyMinor: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  isPublic: boolean;
  sortOrder: number;
}

/**
 * `null` means unlimited. Every key here must have a counter in
 * `usage_records` — a limit that cannot be measured cannot be sold (M24.1).
 */
const PLANS: PlanSeed[] = [
  {
    code: 'free',
    name: 'Free',
    priceMonthlyMinor: 0,
    priceYearlyMinor: 0,
    limits: {
      option_sets: 10,
      products_assigned: 20,
      file_storage_mb: 100,
      stores: 1,
      team_seats: 1,
    },
    // Limited by scale, not capability (D2's recommended shape): a merchant can
    // run one real product line indefinitely and hits the wall only by
    // succeeding. Capability-gating teaches merchants the product is limited;
    // scale-gating teaches them it works.
    features: {
      conditional_rules: true,
      analytics: false,
      rich_text_html: false,
    },
    isPublic: true,
    sortOrder: 1,
  },
  {
    code: 'pro',
    name: 'Pro',
    priceMonthlyMinor: 2900,
    priceYearlyMinor: 29000,
    limits: {
      option_sets: 50,
      products_assigned: null,
      file_storage_mb: 5000,
      stores: 3,
      team_seats: 3,
    },
    features: {
      conditional_rules: true,
      analytics: true,
      rich_text_html: false,
    },
    isPublic: true,
    sortOrder: 2,
  },
  {
    code: 'business',
    name: 'Business',
    priceMonthlyMinor: 7900,
    priceYearlyMinor: 79000,
    limits: {
      option_sets: null,
      products_assigned: null,
      file_storage_mb: 25000,
      stores: 10,
      team_seats: 10,
    },
    features: {
      conditional_rules: true,
      analytics: true,
      rich_text_html: true,
    },
    isPublic: true,
    sortOrder: 3,
  },
];

/**
 * Seed plans, idempotently.
 *
 * Matched on `code`, which is the stable identifier and never renamed. Re-running
 * updates prices and limits on existing rows rather than duplicating them, so
 * this is also how a limit change is applied in development.
 */
export async function seedPlans(dataSource: DataSource): Promise<void> {
  const repository = dataSource.getRepository(Plan);

  let created = 0;
  let updated = 0;

  for (const seed of PLANS) {
    const existing = await repository.findOne({ where: { code: seed.code } });

    if (existing) {
      Object.assign(existing, seed, { currency: 'USD' });
      await repository.save(existing);
      await seedPricesFor(dataSource, existing);
      updated += 1;
      continue;
    }

    const plan = await repository.save(repository.create({ ...seed, currency: 'USD' }));

    await seedPricesFor(dataSource, plan);
    created += 1;
  }

  report('plans', created, updated);
}

/**
 * Give a plan the price rows a subscription can pin to.
 *
 * ## Which column is the source of truth
 *
 * 🔴 **`plan_prices` is, and `plans.priceMonthlyMinor` is now the seed input
 * that populates it.** Step 1 created two money representations for one price
 * and left the question open — which is the duplication its own migration
 * docblock argued against. This is the answer: a **signup reads `plan_prices`**,
 * because that is the row a subscription pins to and the row an old invoice was
 * charged against. The columns on `plans` stay as the seed's declaration of
 * intent and as what a pricing page may display; they are **not** what anyone
 * is billed from.
 *
 * ⚠️ **Not dropped, deliberately.** They are the only prices that exist today,
 * a live seed writes them, and removing a column in the same step that first
 * populates its replacement means one migration doing two jobs. They go when
 * every reader is on `plan_prices` and the guard proves it.
 *
 * ## Idempotent by supersession, not by update
 *
 * 🔴 **A re-run must never rewrite an existing price row.** That is exactly the
 * defect `plan_prices` exists to prevent (F84): a subscription pinned to a row
 * whose amount changes underneath it has been silently re-priced. So a re-run
 * with an unchanged amount does nothing, and a re-run with a **changed** amount
 * retires the current row and writes a new one — which is what a real price
 * change does, in development as in production.
 */
async function seedPricesFor(dataSource: DataSource, plan: Plan): Promise<void> {
  const prices = dataSource.getRepository(PlanPrice);

  const intervals: ReadonlyArray<{ interval: string; amountMinor: number }> = [
    { interval: 'month', amountMinor: plan.priceMonthlyMinor },
    { interval: 'year', amountMinor: plan.priceYearlyMinor },
  ];

  for (const { interval, amountMinor } of intervals) {
    const current = await prices.findOne({
      where: { planId: plan.id, currency: plan.currency, interval, isCurrent: true },
    });

    if (current?.amountMinor === amountMinor) {
      continue;
    }

    if (current) {
      await prices.update(current.id, { isCurrent: false, retiredAt: new Date() });
    }

    const replacement = await prices.save(
      prices.create({
        planId: plan.id,
        currency: plan.currency,
        interval,
        amountMinor,
        isCurrent: true,
      }),
    );

    await recordPriceChange(dataSource, plan, current, replacement);
  }
}

/**
 * Leave a trail when a price is superseded.
 *
 * 🔴 **A price change happened here with no record of it at all.** Seeding
 * retires a row and writes a replacement — the same operation a staff price
 * edit will perform (M26.5) — and until now nothing said which price replaced
 * which, or when. The first time a merchant disputes a charge, *"what were they
 * pinned to and when did that change?"* has to be answerable from the database
 * rather than from a changelog nobody wrote.
 *
 * ⚠️ **`tenantId` and `userId` are null, and that is the honest record**, not a
 * gap: a seed belongs to no tenant and no person. `audit_logs` already models
 * both as nullable with `onDelete: SET NULL`, so a platform-level row needs no
 * schema change. When M26.5 gives staff a real surface, the same rows gain a
 * `userId` from the request context.
 *
 * 📌 **Both amounts, not merely the new one.** *"The price changed"* is not
 * actionable; *"2900 → 4900"* is, and it is what the diff column exists for.
 */
async function recordPriceChange(
  dataSource: DataSource,
  plan: Plan,
  previous: PlanPrice | null,
  replacement: PlanPrice,
): Promise<void> {
  const logs = dataSource.getRepository(AuditLog);

  await logs.save(
    logs.create({
      tenantId: null,
      userId: null,
      action: previous ? 'plan_price.superseded' : 'plan_price.created',
      resourceType: 'plan_price',
      resourceId: replacement.id,
      changes: {
        plan: plan.code,
        currency: replacement.currency,
        interval: replacement.interval,
        amountMinor: previous
          ? { from: previous.amountMinor, to: replacement.amountMinor }
          : { to: replacement.amountMinor },
        /* Named so a reader knows no person did this. */
        source: 'seed',
      },
    }),
  );
}
