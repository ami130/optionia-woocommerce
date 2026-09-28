import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { UsageCounterService, type CountableMetric } from './usage-counter.service';

/** What a metric is called when a merchant reads it. */
const METRIC_LABEL: Record<CountableMetric, string> = {
  option_sets: 'option sets',
  stores: 'stores',
  team_seats: 'team seats',
  products_assigned: 'product assignments',
  file_storage_mb: 'MB of storage',
};

/**
 * Refusing a write that would exceed the tenant's plan (M24.2).
 *
 * ## Why this is not `assertWithinLimit`
 *
 * 📌 **That guard answers a different question and says so.** It caps
 * *structural* shape — options per group, values per option — from a hard-coded
 * constant, and uses `LIMIT_REACHED` precisely because *"no plan raises a
 * structural bound"*. This one is the opposite: every limit here **is** raised
 * by upgrading, which is why it carries `PLAN_LIMIT_EXCEEDED` and names the
 * plan that would help.
 *
 * ## Why the message carries three numbers
 *
 * 🔴 **"You have reached your limit" is not actionable.** M24.2 asks for
 * *"Free plan allows 10 option sets. You have 10. Upgrade to Pro for 50."* —
 * the allowance, the current usage and the way out. A merchant who is told only
 * that they are blocked has to open a support ticket to learn what to do.
 */
@Injectable()
export class PlanLimitGuard {
  constructor(
    private readonly counter: UsageCounterService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Refuse if creating one more would exceed the plan.
   *
   * ⚠️ **Runs inside the caller's transaction when given one**, so the count
   * and the write it protects are one unit of work. Counting outside it lets
   * two concurrent requests both read "9 of 10" and both proceed.
   */
  async assertWithinPlan(
    tenantId: string,
    metric: CountableMetric,
    manager?: EntityManager,
  ): Promise<void> {
    const runner = manager ?? this.dataSource;

    const [plan] = (await runner.query(
      `SELECT p.code, p.name, p.limits, p.sortOrder
         FROM tenants t JOIN plans p ON p.id = t.planId
        WHERE t.id = ?`,
      [tenantId],
    )) as { code: string; name: string; limits: unknown; sortOrder: number }[];

    if (plan === undefined) {
      /*
       * ⚠️ **A tenant with no plan is a data problem, not a merchant problem.**
       * Refusing here would block a paying customer over our own bookkeeping;
       * `tenants.planId` is NOT NULL with a RESTRICT foreign key, so this is
       * unreachable short of a broken migration.
       */
      return;
    }

    const limits = this.asLimits(plan.limits);
    const limit = limits[metric];

    /*
     * 🔴 **`null` means unlimited, and `undefined` means unmetered.** Both must
     * pass. Treating either as `0` would refuse every write on the plan that is
     * *most* permissive — Business has `option_sets: null` — which is the exact
     * inversion a merchant would notice first and trust least.
     */
    if (limit === null || limit === undefined) {
      return;
    }

    const current = await this.counter.count(tenantId, metric, manager);

    if (current < limit) {
      return;
    }

    throw DomainException.planLimit(await this.explain(runner, plan, metric, current, limit), [
      {
        field: metric,
        code: 'PLAN_LIMIT_EXCEEDED',
        params: { limit, current, plan: plan.code },
      },
    ]);
  }

  /**
   * The sentence a merchant reads.
   *
   * 📌 **The upgrade half is omitted when there is nothing to upgrade to.**
   * Telling a merchant on the top plan to upgrade is worse than saying nothing:
   * it sends them looking for a product that does not exist.
   */
  private async explain(
    runner: DataSource | EntityManager,
    plan: { name: string; sortOrder: number },
    metric: CountableMetric,
    current: number,
    limit: number,
  ): Promise<string> {
    const label = METRIC_LABEL[metric];
    const here = `The ${plan.name} plan allows ${limit} ${label}. You have ${current}.`;

    /*
     * ⚠️ **The next plan that actually RAISES this limit**, not simply the next
     * one along. Pro leaves `stores` at 3 where Free allows 1 — but if a metric
     * were unchanged between two tiers, naming the nearer one would send a
     * merchant to pay for no more of the thing they ran out of.
     */
    const [better] = (await runner.query(
      `SELECT name, limits FROM plans
        WHERE sortOrder > ? AND isPublic = TRUE
        ORDER BY sortOrder ASC`,
      [plan.sortOrder],
    )) as { name: string; limits: unknown }[];

    if (better === undefined) {
      return here;
    }

    const raised = this.asLimits(better.limits)[metric];

    if (raised === null) {
      return `${here} Upgrade to ${better.name} for unlimited ${label}.`;
    }

    if (raised === undefined || raised <= limit) {
      return here;
    }

    return `${here} Upgrade to ${better.name} for ${raised} ${label}.`;
  }

  /**
   * 📌 **`plans.limits` is a JSON column**, and this driver hands it back
   * already parsed — but a `TEXT` fallback on an older schema would arrive as a
   * string, and `JSON.parse` on an object throws. Both shapes are accepted
   * rather than assumed.
   */
  private asLimits(raw: unknown): Record<string, number | null | undefined> {
    if (typeof raw === 'string') {
      return JSON.parse(raw) as Record<string, number | null>;
    }

    return (raw ?? {}) as Record<string, number | null>;
  }
}
