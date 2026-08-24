import type { DataSource } from 'typeorm';

import { Plan } from '../plans/entities/plan.entity';
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
      updated += 1;
      continue;
    }

    await repository.save(repository.create({ ...seed, currency: 'USD' }));
    created += 1;
  }

  report('plans', created, updated);
}
