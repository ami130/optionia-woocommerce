import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { UsageCounterService, type CountableMetric } from './usage-counter.service';

/**
 * One metric's usage against the plan (M24.4).
 *
 * 📌 **`atLimit` and `overLimit` are different questions.** At the limit the
 * merchant is blocked from creating more; *over* it they were downgraded into a
 * state they did not choose, and only that second case needs the banner asking
 * them to pick what to disable.
 */
export interface PlanUsage {
  readonly metric: CountableMetric;
  readonly label: string;
  readonly current: number;
  readonly limit: number | null;
  readonly overLimit: boolean;
  readonly atLimit: boolean;
}

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
   * and the write it protects are one unit of work.
   *
   * ✏️ **"When given one" is load-bearing, and two callers do not.**
   * `duplicate`, `importDocument`, `assign` and store creation all pass a
   * manager; `OptionSetsService.create` and `TeamService.invite` do not,
   * because neither opens a transaction at all — the first is a single
   * `repository.save`, and wrapping it to hold a count would be a structural
   * change for a narrow race.
   *
   * 🔴 **So on those two paths the race is real**: two simultaneous requests
   * from one tenant can both read "9 of 10" and both proceed, leaving 11. It
   * is bounded by the number of concurrent requests, self-corrects the moment
   * the merchant deletes anything, and **no database constraint backs any plan
   * limit** — unlike `UNIQUE provider_event_id`, there is no second line of
   * defence here, which is why the guard being reachable on every creation
   * path matters more than this window.
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
   * What the tenant is using against what their plan allows (M24.4).
   *
   * 🔴 **Reports; never repairs.** M24.4 asks to *"prompt for explicit choices
   * about what to disable"* and, in the same breath, to *"never silently delete
   * merchant work"*. An endpoint that offered to delete the excess would be
   * that silent deletion with a dialog in front of it — so this returns the
   * numbers and the merchant acts through the screens they already use.
   *
   * 📌 **Every metric, not only the breached ones.** A dashboard showing "9 of
   * 10 option sets" before the merchant is blocked is the difference between a
   * warning and a surprise.
   */
  async report(tenantId: string, manager?: EntityManager): Promise<PlanUsage[]> {
    const runner = manager ?? this.dataSource;

    const [plan] = (await runner.query(
      `SELECT p.limits FROM tenants t JOIN plans p ON p.id = t.planId WHERE t.id = ?`,
      [tenantId],
    )) as { limits: unknown }[];

    if (plan === undefined) {
      return [];
    }

    const limits = this.asLimits(plan.limits);

    const metrics: CountableMetric[] = [
      'option_sets',
      'stores',
      'team_seats',
      'products_assigned',
      'file_storage_mb',
    ];

    const usage: PlanUsage[] = [];

    for (const metric of metrics) {
      const limit = limits[metric];

      /*
       * ⚠️ **A metric the plan does not mention is not reported.** Listing it
       * as "0 of unlimited" would put a row in the merchant's dashboard for
       * something their plan has no opinion about.
       */
      if (limit === undefined) {
        continue;
      }

      const current = await this.counter.count(tenantId, metric, manager);

      usage.push({
        metric,
        label: METRIC_LABEL[metric],
        current,
        limit,
        /*
         * 🔴 **`null` is unlimited and can never be over.** The same inversion
         * the guard protects against: treating it as 0 would report the most
         * permissive plan as the most breached.
         */
        overLimit: limit !== null && current > limit,
        atLimit: limit !== null && current >= limit,
      });
    }

    return usage;
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
