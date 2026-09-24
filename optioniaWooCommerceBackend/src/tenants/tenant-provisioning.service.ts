import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { TenantRole, TenantStatus } from '../common/database/enums';
import { Plan } from '../plans/entities/plan.entity';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionStatus } from '../common/database/enums';
import { Tenant } from './entities/tenant.entity';
import { TenantMember } from './entities/tenant-member.entity';

/**
 * Creating a tenant for a new merchant.
 *
 * **Always runs inside the caller's transaction.** A user without a tenant cannot
 * do anything, and a tenant without an owner is unreachable — either half alone is
 * a broken account that support has to repair by hand.
 */

/** Days of trial. Matches what the pricing page advertises (M22.1). */
export const TRIAL_DAYS = 14;

@Injectable()
export class TenantProvisioningService {
  /**
   * Create a tenant, make the user its owner, and start the trial.
   *
   * @param manager The caller's transaction. Required, not optional — this is
   *   never correct to run outside one.
   */
  async provision(
    manager: EntityManager,
    userId: string,
    tenantName: string,
  ): Promise<Tenant> {
    const plan = await this.defaultPlan(manager);

    const tenant = await manager.save(
      manager.create(Tenant, {
        name: tenantName.trim().slice(0, 255) || 'My Store',
        slug: await this.uniqueSlug(manager, tenantName),
        // ACTIVE, not a separate trialling status. `TenantStatus` is
        // active/suspended/cancelled by design: a trial is a *billing* state
        // carried by `trialEndsAt`, and conflating the two would mean a lapsed
        // trial had to change status to keep working at free limits.
        status: TenantStatus.ACTIVE,
        planId: plan.id,
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
      }),
    );

    /**
     * The subscription, in the same transaction and for the same reason the
     * member is.
     *
     * 🔴 **Nothing created one before this.** `grep` for `create(Subscription`
     * across the backend returned nothing, so `subscriptions` was an empty table
     * and `tenants.planId` was the only plan reference that existed — which is
     * why step 1 could not drop that column (F84/G6).
     *
     * ⚠️ **Pinned to a price, not only to a plan.** The pin is the whole point:
     * `planId` says which plan's *limits* apply, and `planPriceId` says what this
     * merchant is *charged*, immutably. A subscription with a plan and no price
     * would re-price itself the first time staff edited the plan — the defect
     * `plan_prices` exists to prevent.
     *
     * 📌 **`provider: 'none'`.** A free subscription was never created at a
     * billing provider, and inventing a provider name for it would make the
     * `(provider, providerSubscriptionId)` index meaningless. It becomes a real
     * provider when the merchant first pays.
     */
    const freePrice = await manager.findOne(PlanPrice, {
      where: { planId: plan.id, currency: plan.currency, interval: 'month', isCurrent: true },
    });

    await manager.save(
      manager.create(Subscription, {
        tenantId: tenant.id,
        planId: plan.id,

        /*
         * ⚠️ **Null is tolerated rather than enforced.** A database seeded
         * before prices existed has no row to pin to, and refusing to create the
         * tenant would turn a seeding gap into a failed registration. The plan
         * still governs limits; only the charge is unpinned, and a free plan
         * charges nothing.
         */
        planPriceId: freePrice?.id ?? null,
        provider: 'none',
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: tenant.trialEndsAt,
      }),
    );

    await manager.save(
      manager.create(TenantMember, {
        tenantId: tenant.id,
        userId,
        role: TenantRole.OWNER,
        // Not invited — this person created the tenant. `invitedBy` stays null
        // so the audit trail does not imply someone else granted the access.
        acceptedAt: new Date(),
      }),
    );

    return tenant;
  }

  /**
   * The plan a new tenant starts on.
   *
   * Free rather than the trial tier, because the trial is expressed by
   * `status` and `trialEndsAt` rather than by plan membership — a tenant whose
   * trial lapses should keep working at free limits, not lose its plan row.
   */
  private async defaultPlan(manager: EntityManager): Promise<Plan> {
    const plan = await manager.findOne(Plan, { where: { code: 'free' } });

    if (!plan) {
      throw new Error(
        "No 'free' plan found. Run `npm run db:seed` first — a tenant cannot be " +
          'created without a plan to reference.',
      );
    }

    return plan;
  }

  /**
   * A URL-safe slug that is not already taken.
   *
   * The slug is unique and derived from a name the merchant chose, so collisions
   * are expected rather than exceptional — "My Store" is not an unusual thing to
   * be called. A suffix is appended rather than failing the registration.
   */
  private async uniqueSlug(manager: EntityManager, name: string): Promise<string> {
    const base = slugify(name) || 'store';

    // Bounded rather than unbounded: at some point the right answer is a random
    // slug, not a thousand queries.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const taken = await manager.findOne(Tenant, { where: { slug: candidate } });

      if (!taken) {
        return candidate;
      }
    }

    return `${base}-${randomSuffix()}${randomSuffix()}`;
  }
}

/**
 * Convert a display name into a slug.
 *
 * Deliberately aggressive: anything outside `[a-z0-9-]` is removed rather than
 * transliterated. A slug appears in URLs and in support conversations, and a
 * half-transliterated one is worse than a short generic one.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks left by the decomposition, so "café" becomes "cafe".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    // A trailing hyphen after truncation reads as a mistake.
    .replace(/-+$/g, '');
}

/** Four characters of randomness. Enough to break a collision, short enough to read. */
function randomSuffix(): string {
  return randomBytes(3).toString('base64url').slice(0, 4).toLowerCase();
}
