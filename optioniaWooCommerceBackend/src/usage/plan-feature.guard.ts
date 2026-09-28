import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * A capability a plan either includes or does not (F148).
 *
 * Mirrors the keys seeded into `plans.features`. Named as a union rather than
 * accepting any string so a typo is a compile error: `features` is a JSON
 * column, and an absent key reads as *off* — so a misspelt feature would
 * silently refuse every tenant on every plan.
 */
export type PlanFeature = 'analytics' | 'conditional_rules' | 'rich_text_html';

/** What a feature is called when a merchant reads about it. */
const FEATURE_LABEL: Record<PlanFeature, string> = {
  analytics: 'Analytics',
  conditional_rules: 'Conditional rules',
  rich_text_html: 'Rich text and HTML',
};

/**
 * Refusing a request for a feature the tenant's plan does not include (F148).
 *
 * ## Why this exists at all
 *
 * 🔴 **`plans.features` was seeded in Phase 22 and read by NOTHING.** All three
 * plans carry `analytics` — `false` on Free, `true` on Pro and Business — so
 * the gating decision was made and recorded a phase before this guard, and was
 * then enforced nowhere. `grep` for `.features` outside the entity returned no
 * production reader.
 *
 * This is the **ninth** instance of the defect this project keeps producing: a
 * mechanism with no caller. The eight before it were `createCheckout` (H1),
 * `cancelSubscription`/`updatePlan` (F106), `trialEnding` (V1),
 * `getSubscription` (M23.5), M23.4's worker and reconciler, `PlanLimitGuard`
 * itself (F130), the unrendered `usage[]` (F132) and `plan.read_only` (F137).
 *
 * ⚠️ **So this guard ships with its caller and an HTTP-level test, never
 * alone.** F130 is the precedent: `PlanLimitGuard` passed fifteen unit tests
 * while no route invoked it, because a service-level test proves the decision
 * and says nothing about whether anything asks.
 *
 * ## Why it is separate from `PlanLimitGuard`
 *
 * 📌 **The two answer different questions and fail differently.** A limit is a
 * quantity the merchant consumes and can free up; a feature is a capability
 * they either bought or did not. Merging them would mean one class where half
 * the methods ignore half the state, and one error code for two situations
 * whose remedies differ — see `PLAN_FEATURE_UNAVAILABLE`.
 */
@Injectable()
export class PlanFeatureGuard {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Refuse when the tenant's plan does not include the feature.
   *
   * ⚠️ **Absent means OFF, and that is deliberate.** `plans.features` is JSON,
   * so a feature added to the code before it is added to the seed is missing
   * from every row. Defaulting to *on* would ship an unreleased capability to
   * every tenant including Free; defaulting to *off* withholds it until the
   * plan says otherwise, which is recoverable by a seed update rather than by
   * a refund.
   *
   * @param manager Runs inside the caller's transaction when given one.
   */
  async assertHasFeature(
    tenantId: string,
    feature: PlanFeature,
    manager?: EntityManager,
  ): Promise<void> {
    const runner = manager ?? this.dataSource;

    const [plan] = (await runner.query(
      `SELECT p.name, p.features, p.sortOrder
         FROM tenants t JOIN plans p ON p.id = t.planId
        WHERE t.id = ?`,
      [tenantId],
    )) as { name: string; features: unknown; sortOrder: number }[];

    if (plan === undefined) {
      /*
       * ⚠️ **A tenant with no plan is a data problem, not a merchant problem** —
       * the same reasoning `PlanLimitGuard` records. `tenants.planId` is NOT
       * NULL behind a RESTRICT foreign key, so this is unreachable short of a
       * broken migration, and refusing here would block a paying customer over
       * our own bookkeeping.
       */
      return;
    }

    if (this.asFeatures(plan.features)[feature] === true) {
      return;
    }

    throw new DomainException(
      ErrorCode.PLAN_FEATURE_UNAVAILABLE,
      await this.explain(runner, plan, feature),
      [
        {
          field: feature,
          code: 'PLAN_FEATURE_UNAVAILABLE',
          params: { feature, plan: plan.name },
        },
      ],
    );
  }

  /**
   * Whether the tenant's plan includes the feature, without throwing.
   *
   * 📌 **For rendering, not for guarding.** A dashboard needs to know whether
   * to show an upgrade prompt in place of a chart, and asking by catching an
   * exception would make a normal screen render depend on an error path.
   */
  async hasFeature(
    tenantId: string,
    feature: PlanFeature,
    manager?: EntityManager,
  ): Promise<boolean> {
    const runner = manager ?? this.dataSource;

    const [plan] = (await runner.query(
      `SELECT p.features FROM tenants t JOIN plans p ON p.id = t.planId WHERE t.id = ?`,
      [tenantId],
    )) as { features: unknown }[];

    if (plan === undefined) {
      return false;
    }

    return this.asFeatures(plan.features)[feature] === true;
  }

  /**
   * The sentence a merchant reads.
   *
   * 📌 **The upgrade half is omitted when no public plan includes it.** Telling
   * a merchant on the top plan to upgrade sends them looking for a product that
   * does not exist — the same rule `PlanLimitGuard.explain` follows.
   */
  private async explain(
    runner: DataSource | EntityManager,
    plan: { name: string; sortOrder: number },
    feature: PlanFeature,
  ): Promise<string> {
    const label = FEATURE_LABEL[feature];
    const here = `${label} is not included in the ${plan.name} plan.`;

    /*
     * ⚠️ **The cheapest plan that actually HAS it**, not simply the next one
     * along. A feature could be absent from the next tier and present in the
     * one above, and naming the nearer plan would send a merchant to pay for
     * something that still would not include it.
     */
    const better = (await runner.query(
      `SELECT name, features FROM plans
        WHERE sortOrder > ? AND isPublic = TRUE
        ORDER BY sortOrder ASC`,
      [plan.sortOrder],
    )) as { name: string; features: unknown }[];

    for (const candidate of better) {
      if (this.asFeatures(candidate.features)[feature] === true) {
        return `${here} Upgrade to ${candidate.name} to use it.`;
      }
    }

    return here;
  }

  /**
   * 📌 **`plans.features` is a JSON column**, and this driver hands it back
   * already parsed — but a `TEXT` fallback on an older schema would arrive as a
   * string, and `JSON.parse` on an object throws. Both shapes are accepted
   * rather than assumed, exactly as `asLimits` does.
   */
  private asFeatures(raw: unknown): Record<string, boolean | undefined> {
    if (typeof raw === 'string') {
      return JSON.parse(raw) as Record<string, boolean>;
    }

    return (raw ?? {}) as Record<string, boolean>;
  }
}
