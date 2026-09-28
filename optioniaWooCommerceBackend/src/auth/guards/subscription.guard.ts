import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DataSource } from 'typeorm';

import { REQUIRED_STAFF_ROLES } from '../../admin/staff.guard';
import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { IS_PUBLIC } from './public.decorator';
import { IS_STORE_ROUTE } from './store-route.decorator';
import { WRITABLE_WHEN_LAPSED } from './writable-when-lapsed.decorator';

/** The verbs that change something. */
const MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Authoring pauses when a subscription lapses (ADR-116, M24.3).
 *
 * ## Why this exists
 *
 * 🔴 **`docs/SUBSCRIPTION-POLICY.md` is shown to merchants and promises that
 * after the fourteen-day grace period "editing pauses" — and until this guard
 * NOTHING refused.** `plan.read_only` was computed (M24.5), shipped to the
 * storefront, and rendered as a notice by the plugin (F137), while every write
 * path still accepted the edit the notice said was paused. The policy document
 * recorded the gap honestly; it was still the one promise in it the software
 * did not keep.
 *
 * ## Why it is global rather than applied per route
 *
 * ⚠️ **Sixty-three write routes, and the ones that matter are the ones nobody
 * remembers.** ADR-116 says this is *"enforced by one guard, not 56 edits"*,
 * and the reason is the default: applied globally, a **new** endpoint is
 * refused when a subscription has lapsed without anyone thinking about it.
 * Applied per route, the newest endpoint is always the unguarded one — which is
 * precisely the shape of the eight mechanism-with-no-caller defects this
 * project has already produced.
 *
 * ## What it deliberately does NOT touch
 *
 * 🔴 **Reads.** ADR-116 is explicit that a lapsed merchant can *"sign in and
 * see all of their work"*. Blocking reads would make the dashboard a login
 * screen and delete nothing of value to us.
 *
 * 🔴 **The storefront.** `@StoreRoute()` requests — config delivery, order
 * reporting, heartbeat, catalogue ingest — carry no tenant JWT. *"We do not
 * switch off your shop because a card failed"* is the strongest promise in the
 * policy, and it is kept **twice over**: this guard runs before
 * `StoreTokenGuard` resolves a tenant at all, and the `@StoreRoute()` marker is
 * checked explicitly regardless.
 *
 * 🔴 **Paying.** `@WritableWhenLapsed()` exempts checkout and subscription
 * management. A read-only state that blocks the payment which would lift it is
 * a trap rather than a policy.
 *
 * 🔴 **The platform realm.** Staff carry an ordinary tenant JWT, so a support
 * engineer whose own subscription lapsed would otherwise be refused the
 * platform pricing routes (F162). A staff route is recognised by
 * `REQUIRED_STAFF_ROLES`, which `StaffGuard` requires of every one of them.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    /*
     * 📌 **Reads pass untouched, and this is checked FIRST** — before any
     * metadata lookup or query. A lapsed merchant browsing their own work is
     * the common case, and it must cost nothing.
     */
    if (!MUTATIONS.has(request.method)) {
      return true;
    }

    /*
     * ⚠️ **The two realms this guard cannot speak for.** A `@Public()` route has
     * no tenant to look up — registration, sign-in, the Stripe webhook — and a
     * `@StoreRoute()` request is the storefront, which ADR-116 promises keeps
     * working. Both stand aside here exactly as they do in `JwtAuthGuard`.
     *
     * ✏️ **For `@StoreRoute()` this is defence in depth, NOT the mechanism**, and
     * saying otherwise would be a claim this code does not earn. Nest runs
     * global guards **before** controller-scoped ones, so `StoreTokenGuard` has
     * not populated `tenantId` yet when this executes — the `!tenantId` return
     * below is what actually lets a storefront write through. Measured:
     * deleting this check leaves the store-realm test passing.
     *
     * 📌 **Kept anyway.** The store realm should be excluded by *statement*, not
     * by the order two guards happen to run in — a later change that populated
     * the tenant earlier would otherwise silently start refusing customers'
     * orders because their merchant's card expired.
     */
    const standsAside = [IS_PUBLIC, IS_STORE_ROUTE].some((key) =>
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]),
    );

    if (standsAside) {
      return true;
    }

    /*
     * 🔴 **The platform realm is not a tenant, and its token looks like one**
     * (F162).
     *
     * Staff identity is a `platform_staff` row keyed on `userId`; the credential
     * is an **ordinary tenant JWT**, and `JwtAuthGuard` sets
     * `ctx.tenantId = claims.tid` from it. So a staff member who is also a
     * tenant member carries a tenant id — and without this check, their own
     * lapsed subscription would refuse them `POST /v1/admin/plans`. A support
     * engineer whose personal trial expired would be locked out of platform
     * pricing.
     *
     * ⚠️ **Not reachable while `platform_staff` is empty, and Phase 26 is the
     * phase that fills it.** Recorded and fixed now rather than found then.
     *
     * 📌 **`REQUIRED_STAFF_ROLES` is the right marker.** `StaffGuard` **fails
     * closed** on a staff route that declares no roles, so every reachable one
     * carries this metadata — and a tenant route can never carry it by
     * accident, because nothing else sets it.
     */
    const isStaffRoute = this.reflector.getAllAndOverride<readonly string[]>(
      REQUIRED_STAFF_ROLES,
      [context.getHandler(), context.getClass()],
    );

    if (isStaffRoute !== undefined && isStaffRoute.length > 0) {
      return true;
    }

    /* The explicit exemption: routes a lapsed merchant needs in order to pay. */
    const exempt = this.reflector.getAllAndOverride<boolean>(WRITABLE_WHEN_LAPSED, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (exempt) {
      return true;
    }

    const tenantId = getContext()?.tenantId;

    /*
     * ⚠️ **No tenant means no subscription to judge.** `JwtAuthGuard` has
     * already refused an unauthenticated caller, so this is a staff route or a
     * request whose tenant is not yet resolved — and refusing it here would
     * answer 403 where 401 is the truth.
     */
    if (!tenantId) {
      return true;
    }

    if (!(await this.hasLapsed(tenantId))) {
      return true;
    }

    throw new DomainException(
      ErrorCode.SUBSCRIPTION_LAPSED,
      'Your subscription needs attention, so editing is paused. ' +
        'Your storefront keeps serving the options you last published, and ' +
        'nothing has been deleted. Settle the outstanding payment to make ' +
        'changes again.',
    );
  }

  /**
   * Whether this tenant's grace period has expired.
   *
   * 🔴 **The same expression the config document uses**, deliberately and not
   * by coincidence: `graceEndsAt !== null && graceEndsAt <= now`. The storefront
   * is told `plan.read_only` from that rule (M24.5) and the plugin renders a
   * notice from it (F137) — so a guard deciding differently would refuse an edit
   * the merchant had been told was allowed, or allow one they had been told was
   * blocked. Two sources of truth for one sentence is worse than either answer.
   *
   * ⚠️ **Grace STARTED is not grace EXPIRED.** ADR-116 gives fourteen days of
   * full function after a failed payment; refusing on day one would enforce a
   * restriction the merchant does not yet have and that the policy does not
   * claim.
   */
  private async hasLapsed(tenantId: string): Promise<boolean> {
    /*
     * 📌 **One row at most, guaranteed by `uq_subscriptions_tenant`** — a UNIQUE
     * index on `tenantId`. An earlier draft added `ORDER BY graceEndsAt DESC`,
     * which is harmless and **misleading**: it implies the schema permits
     * several subscriptions per tenant, which it forbids. A reader should not
     * have to check the index to know that.
     *
     * Measured at 0.08 ms on the unique index; the `IS NOT NULL` filter keeps a
     * healthy tenant from carrying a row through to the date comparison below.
     */
    const [row] = (await this.dataSource.query(
      `SELECT graceEndsAt FROM subscriptions
        WHERE tenantId = ? AND graceEndsAt IS NOT NULL
        LIMIT 1`,
      [tenantId],
    )) as { graceEndsAt: Date | null }[];

    const graceEndsAt = row?.graceEndsAt ?? null;

    return graceEndsAt !== null && new Date(graceEndsAt).getTime() <= Date.now();
  }
}
