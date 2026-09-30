'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/layout/states';
import { fetchPublicPlans } from '@/lib/billing/public-api';
import { formatMoney } from '@/lib/billing/format';
import { cn } from '@/lib/utils';

/**
 * What Optionia costs.
 *
 * 🔴 **Readable with no account**, which is why it reads `GET /plans` rather
 * than the authenticated `GET /billing/plans` the subscription screen uses. Both
 * call the same `listPublic()` on the server, so the page a prospect sees and
 * the plans a merchant may choose cannot disagree.
 *
 * 📌 **Yearly, and said once.** The product sells one interval, so repeating
 * "/ year" on every row would be noise; the heading carries it and each card
 * shows a figure.
 */
export default function PricingPage() {
  const plans = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: fetchPublicPlans,
  });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 p-6 py-12">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold">Pricing</h1>
        <p className="text-muted-foreground">
          Every plan is billed yearly. Cancel whenever you like.
        </p>
      </header>

      {plans.isPending ? (
        <LoadingRows rows={3} />
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : plans.data === undefined ? null : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.data.map((plan) => {
            const yearly = plan.prices.find((price) => price.interval === 'year');

            return (
              <Card key={plan.id} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    {plan.name}
                    {yearly?.amountMinor === 0 ? <Badge variant="secondary">Free</Badge> : null}
                  </CardTitle>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-4">
                  <p className="text-2xl font-semibold">
                    {yearly === undefined
                      ? /*
                         * ⚠️ **A plan with no yearly price still renders.**
                         * `listPublic` only returns plans with at least one
                         * sellable price, so this is defensive — but showing a
                         * card with a blank where a figure belongs reads as a
                         * broken page rather than an absent price.
                         */
                        'Contact us'
                      : formatMoney(yearly.amountMinor, yearly.currency)}
                    {yearly !== undefined && yearly.amountMinor > 0 ? (
                      <span className="text-muted-foreground text-sm font-normal"> / year</span>
                    ) : null}
                  </p>

                  {/*
                    📌 **Limits are the comparison.** A prospect choosing between
                    tiers is asking what each one allows, and `listPublic`
                    already returns it — a pricing page that showed only figures
                    would make them guess.
                  */}
                  {Object.keys(plan.limits).length > 0 ? (
                    <dl className="space-y-1 text-sm">
                      {Object.entries(plan.limits).map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">{key}</dt>
                          {/*
                            ⚠️ `null` means UNLIMITED, not missing — an empty
                            cell would read as the opposite of what it means.
                          */}
                          <dd>{value === null ? 'Unlimited' : String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  <div className="mt-auto pt-2">
                    {/*
                      🔴 **To registration, not to checkout.** A visitor here has
                      no account, and sending them at a `planPriceId` they cannot
                      buy yet would answer a price question with a 401.

                      📌 `buttonVariants` rather than `<Button asChild>`: this
                      Button does not take `asChild`, and wrapping a Link in a
                      button element would nest an anchor inside a button.
                    */}
                    <Link href="/register" className={cn(buttonVariants(), 'w-full')}>
                      Get started
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground text-center text-sm">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </div>
  );
}
