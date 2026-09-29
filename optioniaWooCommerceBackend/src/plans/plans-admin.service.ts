import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { getContext } from '../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { PLAN_FEATURES, type PlanFeature } from '../usage/plan-feature.guard';
import {
  COUNTABLE_METRICS,
  type CountableMetric,
} from '../usage/usage-counter.service';
import { Plan } from './entities/plan.entity';
import { PlanPrice } from './entities/plan-price.entity';

/** A plan, with its current prices, as staff need to see it. */
export interface PlanAdminView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isPublic: boolean;
  readonly sortOrder: number;
  readonly limits: Record<string, unknown>;
  /**
   * The plan's capability flags (B10).
   *
   * 🔴 **`limits` was returned here and `features` was not**, so a screen could
   * set a feature and never read it back — the half-built shape this project
   * keeps meeting. Found by a test asserting the response, not by reading the
   * type.
   */
  readonly features: Record<string, boolean>;
  readonly prices: ReadonlyArray<{
    readonly id: string;
    readonly currency: string;
    readonly interval: string;
    readonly amountMinor: number;
    readonly providerPriceId: string | null;
  }>;
}

/**
 * Plan and price administration for platform staff (M22.1a).
 *
 * ## The defect this exists to prevent
 *
 * 🔴 **Mutable plan rows silently re-price existing subscribers.** If editing a
 * plan's price changed the row a subscription points at, everyone on that plan
 * would be re-priced — including merchants who signed up under different terms.
 * The plan calls that *"the single most expensive thing to get wrong here"*, and
 * a merchant discovers it on their card statement.
 *
 * ✅ **Editing a price creates a NEW version.** The old row is retired, existing
 * subscriptions stay pinned to what they bought (`subscriptions.planPriceId`),
 * and only new signups see the new figure. This is how Stripe models prices, for
 * the same reason, which also keeps the provider mapping honest.
 *
 * ## Why every change is attributed
 *
 * ⚠️ **M22.1a's exit criterion requires it**: *"every change is attributable to
 * a named staff user"*, because the first time a merchant disputes a charge the
 * question is who set that price and when. The seed already writes `plan_price`
 * audit rows with a null user; staff changes write the same shape with a real
 * one.
 */
@Injectable()
export class PlansAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * The plans a merchant may actually buy (M22.5).
   *
   * 🔴 **Without this a merchant cannot start a checkout at all.** That route
   * takes a `planPriceId` — the immutable row they buy — and until now the only
   * list of prices was `admin/plans`, which is staff-only. The billing screen
   * had a button and nothing to put in it.
   *
   * ⚠️ **`isPublic` and a provider link are both required.** A hidden plan is
   * withdrawn from signup (though anyone already on it keeps it), and a price
   * with no `providerPriceId` cannot be sold — checkout refuses it, so offering
   * it would be a button that always fails.
   *
   * 📌 **Free prices are offered too.** A merchant downgrading to free needs to
   * see it; the checkout route is what refuses to charge zero, not this list.
   */
  async listPublic(): Promise<PlanAdminView[]> {
    const plans = await this.dataSource.getRepository(Plan).find({
      where: { isPublic: true },
      order: { sortOrder: 'ASC' },
    });

    const prices = await this.dataSource.getRepository(PlanPrice).find({
      where: { isCurrent: true },
    });

    const sellable = prices.filter(
      (price) => price.amountMinor === 0 || price.providerPriceId !== null,
    );

    return plans
      .map((plan) => this.view(plan, sellable))
      .filter((plan) => plan.prices.length > 0);
  }

  /** Every plan, including ones hidden from signup, with current prices. */
  async list(): Promise<PlanAdminView[]> {
    const plans = await this.dataSource.getRepository(Plan).find({
      order: { sortOrder: 'ASC' },
    });

    const prices = await this.dataSource.getRepository(PlanPrice).find({
      where: { isCurrent: true },
    });

    return plans.map((plan) => this.view(plan, prices));
  }

  /**
   * Change a plan's price, by superseding it.
   *
   * 🔴 **Never an UPDATE of `amountMinor`.** The old row must survive because
   * subscriptions point at it — retiring it and inserting a replacement is what
   * keeps an existing subscriber's next invoice unchanged, which is this
   * milestone's exit criterion.
   *
   * ⚠️ **`providerPriceId` is deliberately NOT carried over.** The new local
   * price has no counterpart at the provider until `billing:link-prices` creates
   * one; copying the old id would sell the *old* amount while the dashboard
   * showed the new one — a silent mismatch of exactly the kind F105's verifier
   * exists to catch.
   */
  async setPrice(input: {
    planCode: string;
    currency: string;
    interval: string;
    amountMinor: number;
  }): Promise<{ priceId: string; superseded: string | null }> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new BadRequestException('amountMinor must be a non-negative whole number of minor units');
    }

    if (input.interval !== 'month' && input.interval !== 'year') {
      throw new BadRequestException("interval must be 'month' or 'year'");
    }

    const currency = input.currency.toUpperCase();

    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(Plan, { where: { code: input.planCode } });

      if (plan === null) {
        throw new NotFoundException(`No plan with code ${input.planCode}`);
      }

      const current = await manager.findOne(PlanPrice, {
        where: { planId: plan.id, currency, interval: input.interval, isCurrent: true },
      });

      if (current?.amountMinor === input.amountMinor) {
        throw new BadRequestException('That price is already the current one');
      }

      if (current !== null) {
        await manager.update(PlanPrice, current.id, {
          isCurrent: false,
          retiredAt: new Date(),
        });
      }

      const replacement = await manager.save(
        manager.create(PlanPrice, {
          planId: plan.id,
          currency,
          interval: input.interval,
          amountMinor: input.amountMinor,
          isCurrent: true,
          providerPriceId: null,
        }),
      );

      await this.recordPriceChange(plan, current, replacement);

      return { priceId: replacement.id, superseded: current?.id ?? null };
    });
  }

  /**
   * Show or hide a plan at signup.
   *
   * 🔴 **Hiding is NOT cancelling.** M22.1a is explicit: *"deactivating must
   * hide a plan from signup without cancelling anyone on it."* Nothing here
   * touches a subscription — a merchant on a withdrawn plan keeps it, keeps
   * their price, and keeps their limits until they choose to move.
   */
  async setVisibility(planCode: string, isPublic: boolean): Promise<PlanAdminView> {
    const repository = this.dataSource.getRepository(Plan);
    const plan = await repository.findOne({ where: { code: planCode } });

    if (plan === null) {
      throw new NotFoundException(`No plan with code ${planCode}`);
    }

    if (plan.isPublic === isPublic) {
      throw new BadRequestException(`That plan is already ${isPublic ? 'public' : 'hidden'}`);
    }

    const previous = plan.isPublic;
    plan.isPublic = isPublic;
    await repository.save(plan);

    await this.audit.record({
      action: AuditAction.PLAN_VISIBILITY_CHANGED,
      resourceType: 'plan',
      resourceId: plan.id,
      changes: { code: plan.code, isPublic: { from: previous, to: isPublic } },
      tenantId: null,
      userId: getContext()?.userId ?? null,
    });

    const prices = await this.dataSource.getRepository(PlanPrice).find({
      where: { planId: plan.id, isCurrent: true },
    });

    return this.view(plan, prices);
  }

  /**
   * ⚠️ **The audit row carries both figures, not just the new one.** *"Who
   * changed which price, when, from what to what"* — a row saying only the new
   * amount cannot answer a dispute about what the merchant was charged before.
   */
  private async recordPriceChange(
    plan: Plan,
    previous: PlanPrice | null,
    replacement: PlanPrice,
  ): Promise<void> {
    await this.audit.record({
      action: previous
        ? AuditAction.PLAN_PRICE_SUPERSEDED
        : AuditAction.PLAN_PRICE_CREATED,
      resourceType: 'plan_price',
      resourceId: replacement.id,
      changes: {
        plan: plan.code,
        currency: replacement.currency,
        interval: replacement.interval,
        amountMinor: previous
          ? { from: previous.amountMinor, to: replacement.amountMinor }
          : { to: replacement.amountMinor },
        superseded: previous?.id ?? null,
        source: 'staff',
      },
      tenantId: null,

      /*
       * 🔴 **The named staff user, which is the exit criterion.** The seed
       * writes the same shape with a null user because a seed has no actor;
       * a staff change that lost the actor would be indistinguishable from one.
       */
      userId: getContext()?.userId ?? null,
    });
  }

  private view(plan: Plan, prices: readonly PlanPrice[]): PlanAdminView {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      isPublic: plan.isPublic,
      sortOrder: plan.sortOrder,
      limits: (plan.limits ?? {}) as Record<string, unknown>,
      features: (plan.features ?? {}) as Record<string, boolean>,
      prices: prices
        .filter((price) => price.planId === plan.id)
        .map((price) => ({
          id: price.id,
          currency: price.currency,
          interval: price.interval,
          amountMinor: price.amountMinor,
          providerPriceId: price.providerPriceId,
        })),
    };
  }

  /**
   * How many tenants a proposed limit change would put over (B10).
   *
   * 🔴 **This is the one safeguard ADR-117's amendment leaves standing.** Limit
   * cuts now apply at once, so a merchant mid-term can lose headroom they paid
   * for. The amendment trades that protection for predictability on the
   * condition that an admin can see who a cut affects **before** saving it.
   *
   * ⚠️ **Information, never a block.** Refusing the change would let one large
   * tenant make a plan unchangeable for everyone; the decision stays the
   * admin's, and this only removes the excuse of not knowing.
   *
   * 📌 **Counted with the live usage counter, not a second implementation.** A
   * preview that disagreed with the guard would be worse than none — the admin
   * would act on a number the product does not honour.
   */
  async previewLimitChange(
    planCode: string,
    limits: Readonly<Record<string, number | null>>,
  ): Promise<ReadonlyArray<{ metric: CountableMetric; affected: number; worstExcess: number }>> {
    const plan = await this.requirePlan(planCode);

    const out: Array<{ metric: CountableMetric; affected: number; worstExcess: number }> = [];

    for (const metric of COUNTABLE_METRICS) {
      const proposed = limits[metric];

      /* Unlimited, or unchanged: nobody can be put over by it. */
      if (proposed === null || proposed === undefined) {
        continue;
      }

      const [row] = (await this.dataSource.query(
        `SELECT COUNT(*) AS affected, COALESCE(MAX(used), 0) AS worst FROM (
           SELECT t.id, ${this.usageExpression(metric)} AS used
             FROM tenants t
            WHERE t.planId = ?
         ) counted
          WHERE used > ?`,
        [plan.id, proposed],
      )) as { affected: number | string; worst: number | string }[];

      const affected = Number(row?.affected ?? 0);

      if (affected > 0) {
        out.push({
          metric,
          affected,
          worstExcess: Number(row?.worst ?? 0) - proposed,
        });
      }
    }

    return out;
  }

  /**
   * How a metric's current usage is counted, as SQL.
   *
   * 🔴 **Mirrors `UsageCounterService` clause for clause, and that is the whole
   * requirement.** A preview that disagreed with the guard would be worse than
   * no preview: the admin would act on a number the product does not honour.
   * The first draft of this method was written from memory and was wrong three
   * times over — it invented a `productRef` column on `option_set_assignments`
   * (the column is `targetRef`), missed that `team_seats` counts **pending
   * invitations** as well as members, and used `COUNT(DISTINCT …)` where the
   * counter counts rows. Every clause here was copied from the counter after
   * that, not recalled.
   *
   * ⚠️ **`file_storage_mb` is deliberately absent.** The bytes live on the
   * merchant's own WordPress install and never reach this system — M15.6 pushes
   * the allowance down on the heartbeat and `UploadEndpoint` refuses there. A
   * preview that produced a number for it would be inventing one, so it reports
   * nobody affected rather than a wrong somebody.
   *
   * 🔴 **Every branch is a literal, never interpolated input.** `metric` is
   * narrowed to `CountableMetric` before it arrives and the switch returns fixed
   * strings, so nothing an admin types can reach the query.
   */
  private usageExpression(metric: CountableMetric): string {
    const live = `'${LIVE_SENTINEL_SQL}'`;

    switch (metric) {
      case 'option_sets':
        return `(SELECT COUNT(*) FROM option_sets os
                  WHERE os.tenantId = t.id AND os.deletedAt = ${live})`;

      case 'stores':
        return `(SELECT COUNT(*) FROM stores st WHERE st.tenantId = t.id)`;

      /* Members AND pending invitations — a held seat is a used seat. */
      case 'team_seats':
        return `((SELECT COUNT(*) FROM tenant_members tm
                   WHERE tm.tenantId = t.id AND tm.revokedAt IS NULL)
               + (SELECT COUNT(*) FROM tenant_invitations ti
                   WHERE ti.tenantId = t.id
                     AND ti.acceptedAt IS NULL
                     AND ti.revokedAt IS NULL
                     AND ti.expiresAt > NOW(3)))`;

      case 'products_assigned':
        return `(SELECT COUNT(*)
                   FROM option_set_assignments a
                   JOIN option_sets s ON s.id = a.optionSetId
                  WHERE s.tenantId = t.id
                    AND a.deletedAt = ${live}
                    AND s.deletedAt = ${live})`;

      default:
        /* file_storage_mb — not measurable from here; see the docblock. */
        return '0';
    }
  }

  /**
   * Replace a plan's enforceable allowances (B10).
   *
   * 🔴 **Validated against what this system can actually enforce.** The entity's
   * own rule is that every limit must be *measurable in code*; a key nothing
   * counts would be a promise on a pricing page that no guard keeps, and
   * `limits` is a JSON column so nothing else would reject it.
   *
   * ⚠️ **It REPLACES rather than merges.** A merge cannot express *"remove this
   * limit"* — the absent key is what `PlanLimitGuard` reads as unmetered — so a
   * partial write would make removal impossible while looking like it worked.
   *
   * ⚠️ **This reaches existing subscribers at once** (ADR-117, amended
   * 2026-09-29). Unlike a price, there is no pinned row protecting them.
   */
  async setLimits(
    planCode: string,
    limits: Readonly<Record<string, number | null>>,
  ): Promise<PlanAdminView> {
    const plan = await this.requirePlan(planCode);

    const known = new Set<string>(COUNTABLE_METRICS);
    const unknown = Object.keys(limits).filter((key) => !known.has(key));

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown limit(s): ${unknown.join(', ')}. This system enforces: ${COUNTABLE_METRICS.join(', ')}.`,
      );
    }

    for (const [metric, value] of Object.entries(limits)) {
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        throw new BadRequestException(
          `Limit "${metric}" must be a whole number of 0 or more, or null for unlimited.`,
        );
      }
    }

    const previous = plan.limits;

    await this.dataSource.getRepository(Plan).update(plan.id, { limits });

    await this.audit.record({
      action: AuditAction.PLAN_LIMITS_CHANGED,
      resourceType: 'plan',
      resourceId: plan.id,
      changes: { code: plan.code, limits: { from: previous, to: limits } },
      tenantId: null,
      userId: getContext()?.userId ?? null,
    });

    return this.viewOf(plan.code);
  }

  /**
   * Replace a plan's capability flags (B10).
   *
   * 🔴 **Validated against the features something actually gates.** `features`
   * is a JSON column and an absent key reads as *off*, so a misspelt flag would
   * be stored happily, gate nothing, and appear on a pricing page as a
   * capability the product does not have.
   *
   * ⚠️ **Turning one off takes the screen away from every tenant on the plan at
   * once**, because `PlanFeatureGuard` reads this live.
   */
  async setFeatures(
    planCode: string,
    features: Readonly<Record<string, boolean>>,
  ): Promise<PlanAdminView> {
    const plan = await this.requirePlan(planCode);

    const known = new Set<string>(PLAN_FEATURES);
    const unknown = Object.keys(features).filter((key) => !known.has(key));

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown feature(s): ${unknown.join(', ')}. This system gates: ${PLAN_FEATURES.join(', ')}.`,
      );
    }

    const previous = plan.features;

    await this.dataSource
      .getRepository(Plan)
      .update(plan.id, { features: features as Record<PlanFeature, boolean> });

    await this.audit.record({
      action: AuditAction.PLAN_FEATURES_CHANGED,
      resourceType: 'plan',
      resourceId: plan.id,
      changes: { code: plan.code, features: { from: previous, to: features } },
      tenantId: null,
      userId: getContext()?.userId ?? null,
    });

    return this.viewOf(plan.code);
  }

  /** The plan, or a 404 naming the code that was not found. */
  private async requirePlan(planCode: string): Promise<Plan> {
    const plan = await this.dataSource
      .getRepository(Plan)
      .findOne({ where: { code: planCode } });

    if (!plan) {
      throw new NotFoundException(`No plan with code "${planCode}".`);
    }

    return plan;
  }

  /** One plan in the shape `list()` returns, after a write. */
  private async viewOf(planCode: string): Promise<PlanAdminView> {
    const all = await this.list();
    const found = all.find((plan) => plan.code === planCode);

    if (!found) {
      throw new NotFoundException(`No plan with code "${planCode}".`);
    }

    return found;
  }
}
