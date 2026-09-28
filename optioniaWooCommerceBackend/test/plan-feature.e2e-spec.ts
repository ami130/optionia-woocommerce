import { DataSource } from 'typeorm';

import { PlanFeatureGuard } from '../src/usage/plan-feature.guard';
import { createHarness, type Harness } from './harness';

/**
 * F148 — a plan's feature flags actually decide something.
 *
 * ## Why this suite exists
 *
 * 🔴 **`plans.features` was seeded in Phase 22 and read by NOTHING.** All three
 * plans carry `analytics` — `false` on Free, `true` on Pro and Business — so
 * the decision was made, recorded, and then enforced nowhere. A `grep` for
 * `.features` outside the entity returned no production reader at all.
 *
 * ⚠️ **This suite proves the guard DECIDES correctly and deliberately does not
 * claim anything CALLS it.** That second question is F130's lesson and it is
 * answered by `PlanLimitGuard`'s HTTP suite, not by this one: the analytics
 * routes this guard is for arrive in Stage 25-1, and their own HTTP test is
 * what will prove the guard is reached. Asserting reachability here, against a
 * route that does not exist, is precisely the self-satisfying test that let
 * F130 survive review.
 */
describe('Plan features (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let guard: PlanFeatureGuard;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('planfeat');
    dataSource = h.dataSource;

    await h.tenant('owner');
    tenantId = await h.tenantIdOf('owner');

    guard = h.app.get(PlanFeatureGuard, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await h.cleanup();
    await h.close();
  });

  /** Put the tenant on a named plan. */
  async function onPlan(code: string): Promise<void> {
    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = ?) WHERE id = ?`,
      [code, tenantId],
    );
  }

  /**
   * 🔴 **Free does not include analytics, and is refused.** This is the
   * seeded decision; before this guard it was inert.
   */
  it('refuses a feature the plan does not include', async () => {
    await onPlan('free');

    await expect(guard.assertHasFeature(tenantId, 'analytics')).rejects.toThrow(
      /Analytics is not included in the Free plan/,
    );
  });

  /**
   * 🔴 **The merchant is told the way out**, as M24.2 requires of every plan
   * refusal — a refusal without a remedy is a support ticket.
   */
  it('names the cheapest plan that includes it', async () => {
    await onPlan('free');

    await expect(guard.assertHasFeature(tenantId, 'analytics')).rejects.toThrow(
      /Upgrade to Pro to use it/,
    );
  });

  /** 📌 A plan that includes the feature passes silently. */
  it('allows a feature the plan includes', async () => {
    await onPlan('pro');

    await expect(guard.assertHasFeature(tenantId, 'analytics')).resolves.toBeUndefined();
  });

  /**
   * 🔴 **403, never 429.** `PLAN_LIMIT_EXCEEDED` is a 429 because waiting or
   * deleting can resolve it. A feature gate cannot be waited out, and a 429
   * would invite a retry that can never succeed.
   */
  it('answers 403 with a code distinct from a plan limit', async () => {
    await onPlan('free');

    /*
     * ⚠️ **`getStatus()`, not a `status` property.** `DomainException` extends
     * `HttpException`, which exposes the status through a method — asserting a
     * bare property would read `undefined` and pass against any status at all.
     */
    const error = (await guard
      .assertHasFeature(tenantId, 'analytics')
      .catch((e: unknown) => e)) as { code: string; getStatus: () => number };

    expect(error.code).toBe('PLAN_FEATURE_UNAVAILABLE');
    expect(error.getStatus()).toBe(403);
  });

  /**
   * 🔴 **The refusal carries structured detail**, so a dashboard can render an
   * upgrade prompt without parsing the sentence — the same contract
   * `PLAN_LIMIT_EXCEEDED` keeps.
   */
  it('carries the feature and the plan as structured detail', async () => {
    await onPlan('free');

    const error = (await guard
      .assertHasFeature(tenantId, 'analytics')
      .catch((e: unknown) => e)) as {
      details?: { field: string; code: string; params: Record<string, unknown> }[];
    };

    expect(error.details?.[0]).toMatchObject({
      field: 'analytics',
      code: 'PLAN_FEATURE_UNAVAILABLE',
      params: { feature: 'analytics', plan: 'Free' },
    });
  });

  /**
   * ⚠️ **An absent key is OFF, not on.** A feature added to the code before the
   * seed is missing from every row; defaulting to *on* would ship an unreleased
   * capability to every tenant including Free.
   */
  it('treats a feature the plan does not mention as unavailable', async () => {
    await onPlan('business');

    await dataSource.query(
      `UPDATE plans SET features = JSON_REMOVE(features, '$.analytics') WHERE code = 'business'`,
    );

    try {
      await expect(guard.assertHasFeature(tenantId, 'analytics')).rejects.toThrow(
        /not included in the Business plan/,
      );
    } finally {
      await dataSource.query(
        `UPDATE plans SET features = JSON_SET(features, '$.analytics', TRUE) WHERE code = 'business'`,
      );
    }
  });

  /**
   * ⚠️ **No upgrade is offered when no plan above has it.** Telling a merchant
   * on the top plan to upgrade sends them looking for a product that does not
   * exist.
   */
  it('omits the upgrade when nothing above includes it', async () => {
    await onPlan('business');

    await dataSource.query(
      `UPDATE plans SET features = JSON_SET(features, '$.analytics', FALSE) WHERE code = 'business'`,
    );

    try {
      await expect(guard.assertHasFeature(tenantId, 'analytics')).rejects.toThrow(
        /^Analytics is not included in the Business plan\.$/,
      );
    } finally {
      await dataSource.query(
        `UPDATE plans SET features = JSON_SET(features, '$.analytics', TRUE) WHERE code = 'business'`,
      );
    }
  });

  /**
   * 🔴 **It names the cheapest plan that HAS it, not the next one along.** A
   * feature absent from the next tier and present above it would otherwise send
   * a merchant to pay for something that still would not include it.
   */
  it('skips a tier that also lacks the feature', async () => {
    await onPlan('free');

    await dataSource.query(
      `UPDATE plans SET features = JSON_SET(features, '$.analytics', FALSE) WHERE code = 'pro'`,
    );

    try {
      await expect(guard.assertHasFeature(tenantId, 'analytics')).rejects.toThrow(
        /Upgrade to Business to use it/,
      );
    } finally {
      await dataSource.query(
        `UPDATE plans SET features = JSON_SET(features, '$.analytics', TRUE) WHERE code = 'pro'`,
      );
    }
  });

  /**
   * 📌 **`hasFeature` answers without throwing**, so a screen deciding whether
   * to render a chart or an upgrade prompt does not depend on an error path.
   */
  it('reports availability without raising', async () => {
    await onPlan('free');
    await expect(guard.hasFeature(tenantId, 'analytics')).resolves.toBe(false);

    await onPlan('pro');
    await expect(guard.hasFeature(tenantId, 'analytics')).resolves.toBe(true);
  });
});
