import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { getContext } from '../common/context/request-context';
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
}
