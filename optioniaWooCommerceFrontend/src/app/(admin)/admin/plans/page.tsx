'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingRows } from '@/components/layout/states';
import {
  MAX_DISCOUNT_BASIS_POINTS,
  type AdminPlan,
  discountPlan,
  fetchAdminPlans,
} from '@/lib/admin/api';
import { formatMoney } from '@/lib/billing/format';

/**
 * Plan administration (M26.5).
 *
 * 🔴 **The first screen behind the `(admin)` group**, which stood empty from the
 * day it was created — closed on purpose, pending the staff identity that
 * `/auth/me` now reports. `RequirePlatformStaff` decides who renders it;
 * `StaffGuard` authorises every request it makes, so a merchant who edited their
 * way here would see a shell and a string of 403s rather than platform data.
 *
 * 📌 **Read-first.** Every plan, what it costs, and whether that price can
 * actually be bought — the questions staff ask before changing anything. The one
 * mutation is a discount, because that is the control the product needs and the
 * backend already proves.
 */
export default function AdminPlansPage() {
  const queryClient = useQueryClient();

  const plans = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: fetchAdminPlans,
  });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="text-muted-foreground text-sm">
          What every plan costs, and whether a merchant can buy it.
        </p>
      </header>

      {plans.isPending ? (
        <LoadingRows rows={3} />
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : /*
           * ⚠️ **Narrowed explicitly, not left to the branch order.** A query
           * can settle without error and still hold no data, and rendering the
           * populated view over `undefined` is the `/connect` defect this
           * project already met once. Checking `isError` alone leaves that path
           * open.
           */
      plans.data === undefined ? null : (
        <div className="space-y-4">
          {plans.data.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onChanged={() =>
                void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, onChanged }: { plan: AdminPlan; onChanged: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">
          {plan.name}
          <span className="text-muted-foreground ml-2 text-xs font-normal">{plan.code}</span>
        </CardTitle>

        {/*
          ⚠️ **Hidden means withdrawn from SIGNUP, not cancelled.** A merchant
          already on the plan keeps it, their pinned price and their limits —
          only what a new signup may choose changes.
        */}
        <Badge variant={plan.isPublic ? 'default' : 'secondary'}>
          {plan.isPublic ? 'On sale' : 'Hidden from signup'}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {plan.prices.length === 0 ? (
          <p className="text-muted-foreground text-sm">No current price.</p>
        ) : (
          <ul className="space-y-2">
            {plan.prices.map((price) => (
              <li key={price.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {formatMoney(price.amountMinor, price.currency)}
                  <span className="text-muted-foreground"> / {price.interval}</span>
                </span>

                {/*
                  🔴 **A price with no provider id cannot be bought.** Checkout
                  refuses it, so showing it as live would be a figure staff
                  believe is on sale while every merchant who tries is turned
                  away. A free price needs no link — nothing is charged.
                */}
                {price.providerPriceId === null && price.amountMinor > 0 ? (
                  <Badge variant="outline">Not linked to Stripe</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/*
          🔴 **Limits and features are shown, not merely fetched.** `GET
          /admin/plans` returns both and this screen displayed neither — the
          half-built shape this project keeps meeting, where a field crosses the
          wire and no screen reads it. B10 made them editable without a deploy;
          seeing them is the first half of that being useful.
        */}
        <PlanAllowances plan={plan} />

        <DiscountForm plan={plan} onChanged={onChanged} />
      </CardContent>
    </Card>
  );
}

/**
 * What a plan allows, and which capabilities it unlocks.
 *
 * 📌 **Read-only here.** `PUT /admin/plans/:code/limits` and `.../features`
 * exist and are gated; editing them is a larger screen than this milestone
 * needs, and showing the current values is what staff answering a merchant's
 * question actually require.
 */
function PlanAllowances({ plan }: { plan: AdminPlan }) {
  const limits = Object.entries(plan.limits);
  const features = Object.entries(plan.features).filter(([, on]) => on);

  if (limits.length === 0 && features.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 border-t pt-4">
      {limits.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {limits.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              {/*
                ⚠️ **`null` means UNLIMITED, not missing.** Rendering it as an
                empty cell would read as "no allowance recorded", which is the
                opposite of what it means.
              */}
              <dd>{value === null ? 'Unlimited' : String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {features.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {features.map(([key]) => (
            <Badge key={key} variant="secondary" className="font-normal">
              {key}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Discount a plan.
 *
 * 🔴 **A discount is a PRICE CHANGE.** It retires the current row and writes a
 * replacement, so an existing subscriber's next invoice is unchanged — they stay
 * pinned to the price they bought. The form says so, because "20% off" sounds
 * like it might reprice everyone.
 */
function DiscountForm({ plan, onChanged }: { plan: AdminPlan; onChanged: () => void }) {
  const [percent, setPercent] = useState('');

  const yearly = plan.prices.find((p) => p.interval === 'year');

  const discount = useMutation({
    mutationFn: () =>
      discountPlan({
        code: plan.code,
        currency: yearly?.currency ?? 'USD',
        interval: 'year',
        /*
         * 📌 **Percent in, basis points out.** Staff think in percentages; the
         * API takes basis points because money arithmetic is integer throughout.
         * `Math.round` keeps 12.5% exact (1250) rather than truncating to 1200.
         */
        basisPoints,
      }),
    onSuccess: () => {
      setPercent('');
      onChanged();
    },
  });

  /*
   * 🔴 **Validated in BASIS POINTS, the unit the API takes.** Checking the
   * percent against `< 100` let 99.995% through, which rounds to 10000 and is
   * refused by the server — the form said yes where the server said no.
   * Converting first, then bounding, makes the client and server agree by
   * construction rather than by two numbers that happen to match.
   */
  const value = Number(percent);
  const basisPoints = Math.round(value * 100);
  const valid =
    percent !== '' &&
    Number.isFinite(value) &&
    value >= 0 &&
    basisPoints <= MAX_DISCOUNT_BASIS_POINTS;

  /*
   * ⚠️ **No form on a free plan.** The Free plan has a yearly price of £0, so
   * the row exists and the control rendered — offering staff a discount that
   * cannot do anything, since 20% off nothing is nothing. Hidden rather than
   * disabled: there is no state in which it becomes useful.
   */
  if (!yearly || yearly.amountMinor === 0) {
    return null;
  }

  return (
    <form
      className="space-y-2 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (valid) {
          discount.mutate();
        }
      }}
    >
      <Label htmlFor={`discount-${plan.code}`} className="text-xs">
        Discount the list price
      </Label>

      <div className="flex items-center gap-2">
        <Input
          id={`discount-${plan.code}`}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
          inputMode="decimal"
          placeholder="20"
          className="w-24"
          aria-describedby={`discount-help-${plan.code}`}
        />
        <span className="text-muted-foreground text-sm">% off</span>

        <Button type="submit" size="sm" disabled={!valid || discount.isPending}>
          {discount.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </div>

      <p id={`discount-help-${plan.code}`} className="text-muted-foreground text-xs">
        Retires the current price and writes a new one. Merchants already
        subscribed keep the price they bought.
      </p>

      {discount.isError ? (
        <ErrorState error={discount.error} />
      ) : null}

      {discount.isSuccess ? (
        <p className="text-sm">
          Now {formatMoney(discount.data.amountMinor, yearly.currency)}, saving{' '}
          {formatMoney(discount.data.savingMinor, yearly.currency)} off{' '}
          {formatMoney(discount.data.listMinor, yearly.currency)}.
        </p>
      ) : null}
    </form>
  );
}
