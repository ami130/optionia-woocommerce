import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type BillingProviderOrNull,
} from './billing-provider';

/**
 * What differs between the provider and this database (M23.5).
 *
 * 📌 **A finding names the field, both values, and the tenant** — *"the state
 * drifted"* is not actionable, and `active → past_due` is.
 */
export interface DriftFinding {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly providerSubscriptionId: string;
  readonly field: 'status' | 'currentPeriodEnd' | 'planPriceId' | 'providerCustomerId' | 'missing';
  readonly local: string | null;
  readonly remote: string | null;
  readonly repaired: boolean;
}

export interface ReconcileSubscriptionsOptions {
  /**
   * 🔴 **Default true, deliberately.** See the class docblock: a job that writes
   * on every difference is one provider outage away from mass-downgrading
   * paying merchants.
   */
  readonly dryRun?: boolean;
}

export interface ReconcileSubscriptionsOutcome {
  readonly checked: number;
  readonly skipped: number;
  readonly findings: DriftFinding[];
  /** 🔴 Our own bugs and provider outages, kept apart from drift. */
  readonly errors: string[];
}

/**
 * The scheduled diff M23.5 requires: provider state against local state.
 *
 * ## Why this exists
 *
 * 🔴 **Webhooks are the only thing that moves subscription state, and a webhook
 * can be missed.** Phase 23 makes delivery idempotent and ordered, but nothing
 * makes it *guaranteed*: a 500 that outlives Stripe's retry schedule, an
 * endpoint misconfigured for a day, a deploy that drops a delivery. The result
 * is a paying merchant stranded on the wrong plan, and **nothing in the system
 * would ever notice**. This is what notices.
 *
 * ## A mirror, never a source of truth
 *
 * ⚠️ **A difference is a FINDING, not an instruction.** F91 set this principle
 * for `invoices` and `plan_prices` and it holds here: the provider is
 * authoritative about what it charged, but *acting* on every difference
 * automatically is dangerous in a way that reporting is not. A provider outage
 * that answered oddly, or a bug in this very comparison, would otherwise
 * rewrite every subscription in the database in one pass.
 *
 * 🔴 **So `dryRun` defaults to TRUE** and repair is opt-in. That is the
 * opposite of the usual default and it is the point.
 *
 * ## Why this is a service and not a cron decoration
 *
 * 📌 **The milestone says "scheduled diff"; the value is the diff.** How it is
 * triggered — a cron entry, BullMQ, `@nestjs/schedule`, a Kubernetes CronJob —
 * changes not one line below, and M23.4's infrastructure decision is still
 * open. `billing:link-prices` already established the pattern: the logic lives
 * in a service, a thin command runs it, and the deployment decides when.
 */
@Injectable()
export class SubscriptionReconcilerService {
  private readonly logger = new Logger(SubscriptionReconcilerService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(PlanPrice)
    private readonly prices: Repository<PlanPrice>,
    /*
     * ⚠️ **Nullable, like every other consumer of this token.** G2's finding:
     * an injection token is a bare symbol and carries no type, so the nullable
     * type has to be written out or a billing-less deployment crashes at
     * startup instead of skipping this work.
     */
    @Optional()
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProviderOrNull,
  ) {}

  async reconcile(
    options: ReconcileSubscriptionsOptions = {},
  ): Promise<ReconcileSubscriptionsOutcome> {
    const dryRun = options.dryRun ?? true;

    if (this.provider === null) {
      return {
        checked: 0,
        skipped: 0,
        findings: [],
        errors: ['No billing provider is configured; nothing to reconcile against.'],
      };
    }

    /*
     * 🔴 **Only subscriptions the provider actually knows about.** A free
     * tenant has `provider: 'none'` and no remote id; asking Stripe about it
     * would be a guaranteed `resource_missing` and would report every free
     * merchant in the database as drift.
     */
    const candidates = await this.subscriptions.find({
      where: { provider: Not('none'), providerSubscriptionId: Not(IsNull()) },
    });

    const findings: DriftFinding[] = [];
    const errors: string[] = [];
    let checked = 0;

    for (const subscription of candidates) {
      const providerSubscriptionId = subscription.providerSubscriptionId;

      if (providerSubscriptionId === null) {
        continue;
      }

      checked += 1;

      try {
        const remote = await this.provider.getSubscription(providerSubscriptionId);

        if (remote === null) {
          /*
           * 🔴 **"The provider has forgotten this" is a finding, never a
           * repair.** Deleting or cancelling local state because a lookup
           * returned null would act on the one answer most likely to be a
           * misconfiguration — the wrong API key points at an account where
           * none of our ids exist, and every subscription looks missing.
           */
          findings.push({
            tenantId: subscription.tenantId,
            subscriptionId: subscription.id,
            providerSubscriptionId,
            field: 'missing',
            local: subscription.status,
            remote: null,
            repaired: false,
          });

          continue;
        }

        findings.push(...(await this.compare(subscription, remote, dryRun)));
      } catch (error) {
        /*
         * ⚠️ **Our bug, not their drift.** F93 narrowed the adapter's catch to
         * `resource_missing` precisely so this distinction survives: a
         * malformed id or a rejected parameter must not be recorded as "the
         * provider forgot this subscription", or the real bug never surfaces.
         */
        errors.push(`${providerSubscriptionId}: ${(error as Error).message}`);
      }
    }

    if (findings.length > 0) {
      this.logger.warn(
        `Reconciliation found ${findings.length} difference(s) across ${checked} subscription(s)` +
          (dryRun ? ' (dry run: nothing was written)' : ''),
      );
    }

    return {
      checked,
      skipped: candidates.length - checked,
      findings,
      errors,
    };
  }

  /**
   * Compare the four fields that can drift, and repair only when asked.
   *
   * 📌 **Each field is reported independently.** One subscription can drift in
   * two ways at once — a missed renewal and a portal plan change — and
   * collapsing them to a single "differs" hides the one that matters.
   */
  private async compare(
    subscription: Subscription,
    remote: Awaited<ReturnType<BillingProvider['getSubscription']>> & object,
    dryRun: boolean,
  ): Promise<DriftFinding[]> {
    const found: DriftFinding[] = [];
    const providerSubscriptionId = subscription.providerSubscriptionId as string;

    const record = (
      field: DriftFinding['field'],
      local: string | null,
      value: string | null,
    ): void => {
      found.push({
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        providerSubscriptionId,
        field,
        local,
        remote: value,
        repaired: !dryRun,
      });
    };

    let changed = false;

    if (subscription.status !== remote.status) {
      record('status', subscription.status, remote.status);

      if (!dryRun) {
        subscription.status = remote.status as SubscriptionStatus;
        changed = true;
      }
    }

    /*
     * 🔴 **F118's field, now with a second net.** `currentPeriodEnd` was
     * permanently null in production and five merchant-visible behaviours broke
     * on it. Comparing by epoch milliseconds rather than by `Date` identity,
     * because two `Date` objects are never `===`.
     */
    const localPeriodEnd = subscription.currentPeriodEnd?.getTime() ?? null;
    const remotePeriodEnd = remote.currentPeriodEnd?.getTime() ?? null;

    if (localPeriodEnd !== remotePeriodEnd) {
      record(
        'currentPeriodEnd',
        subscription.currentPeriodEnd?.toISOString() ?? null,
        remote.currentPeriodEnd?.toISOString() ?? null,
      );

      if (!dryRun) {
        subscription.currentPeriodEnd = remote.currentPeriodEnd;
        changed = true;
      }
    }

    if (
      remote.providerCustomerId !== null &&
      subscription.providerCustomerId !== remote.providerCustomerId
    ) {
      record('providerCustomerId', subscription.providerCustomerId, remote.providerCustomerId);

      if (!dryRun) {
        subscription.providerCustomerId = remote.providerCustomerId;
        changed = true;
      }
    }

    /*
     * 🔴 **A plan change made in Stripe's own portal reaches us only here** if
     * its webhook was missed — and the consequence is a merchant on the wrong
     * plan limits, which Phase 24 will enforce against.
     *
     * ⚠️ **An unknown price is a finding, not a repair.** `plan_prices` is the
     * join, and a price we have never seen means our catalogue is behind —
     * pointing `planPriceId` at nothing would make it worse.
     */
    if (remote.providerPriceId !== null) {
      const price = await this.prices.findOne({
        where: { providerPriceId: remote.providerPriceId },
      });

      if (price === null) {
        record('planPriceId', subscription.planPriceId, `unknown price ${remote.providerPriceId}`);
      } else if (price.id !== subscription.planPriceId) {
        record('planPriceId', subscription.planPriceId, price.id);

        if (!dryRun) {
          subscription.planPriceId = price.id;
          subscription.planId = price.planId;
          changed = true;
        }
      }
    }

    if (changed) {
      await this.subscriptions.save(subscription);
    }

    return found;
  }
}
