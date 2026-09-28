'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AsyncState, EmptyState, ErrorState, LoadingRows } from '@/components/layout/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useSession } from '@/components/providers/session-provider';
import { roleCan } from '@/lib/auth/capabilities';
import {
  cancelSubscription,
  getSubscription,
  listInvoices,
  listPlans,
  openPortal,
  startCheckout,
  type InvoiceSummary,
  type PlanUsage,
  type PurchasablePlan,
  type SubscriptionSummary,
} from '@/lib/billing/api';
import { formatDate, formatMoney } from '@/lib/billing/format';

/**
 * What this account pays, and what it has paid (M22.5).
 *
 * 🔴 **The backend has been complete and unreachable.** Every route this page
 * calls was built, tested against real Stripe, and rendered by nothing — so a
 * merchant could not pay, could not see an invoice, and could not cancel. A
 * working billing system nobody can open is not a billing system.
 *
 * ⚠️ **`billing:view` is held by `owner` and `billing` only — NOT by `admin`.**
 * Read from the API's table rather than inferred: an admin runs the product;
 * money is a separate trust. A member without it sees the page and is told so,
 * rather than being shown buttons that answer 403.
 */
export default function SubscriptionPage() {
  const queryClient = useQueryClient();
  const { me } = useSession();

  const canView = roleCan(me?.role, 'billing:view');
  const canManage = roleCan(me?.role, 'billing:manage');

  const subscription = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: getSubscription,
    enabled: canView,

    /*
     * 🔴 **Poll while a checkout is settling.** `checkout.session.completed`
     * links the provider ids and deliberately does not set `active`; the real
     * terms arrive moments later on `customer.subscription.updated`. Without
     * this the merchant who just paid stares at the plan they left and
     * reasonably concludes the payment failed.
     */
    refetchInterval: (query) =>
      query.state.data?.settling === true ? 3_000 : false,
  });

  const invoices = useQuery({
    queryKey: ['billing', 'invoices'],
    queryFn: listInvoices,
    enabled: canView,
  });

  const plans = useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: listPlans,
    enabled: canManage,
  });

  const checkout = useMutation({
    mutationFn: startCheckout,
    onSuccess: ({ url }) => {
      /*
       * 🔴 **A full navigation to the provider.** The merchant returns to
       * `/billing?checkout=success`, where the settling notice takes over — a
       * new tab would leave them on a page that never updates.
       */
      window.location.href = url;
    },
  });

  const portal = useMutation({
    mutationFn: openPortal,
    onSuccess: ({ url }) => {
      /*
       * ⚠️ **A full navigation, not a new tab.** The portal returns the
       * merchant here when they finish, and a popup blocker eating the link
       * looks like a dead button.
       */
      window.location.href = url;
    },
  });

  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const cancel = useMutation({
    mutationFn: () => cancelSubscription(reason.trim() === '' ? null : reason.trim()),
    onSuccess: async () => {
      setConfirming(false);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
  });

  if (!canView) {
    return (
      <EmptyState
        title="Billing is not available for your role"
        description="Ask an owner to view or change what this account pays."
        action={null}
      />
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Subscription</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What this account is on, and every invoice we have issued.
        </p>
      </header>

      {subscription.isLoading ? (
        <LoadingRows rows={2} />
      ) : subscription.error !== null ? (
        <ErrorState error={subscription.error} onRetry={() => void subscription.refetch()} />
      ) : subscription.data === undefined ? null : (
        <CurrentPlan
          summary={subscription.data}
          canManage={canManage}
          onOpenPortal={() => portal.mutate()}
          portalPending={portal.isPending}
          portalError={portal.error}
        />
      )}

      {subscription.data !== undefined && canManage && !subscription.data.settling && (
        <CancelSection
          summary={subscription.data}
          confirming={confirming}
          onConfirming={setConfirming}
          reason={reason}
          onReason={setReason}
          onCancel={() => cancel.mutate()}
          pending={cancel.isPending}
          error={cancel.error}
        />
      )}

      {canManage && subscription.data !== undefined && !subscription.data.settling && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Change plan</h2>

          <AsyncState
            isLoading={plans.isLoading}
            error={plans.error}
            data={plans.data}
            onRetry={() => void plans.refetch()}
            empty={
              <EmptyState
                title="No plans are available"
                description="Nothing is on sale right now. Please contact support."
                action={null}
              />
            }
          >
            {(rows) => (
              <PlanPicker
                plans={rows}
                currentPlanCode={subscription.data.planCode}
                onChoose={(planPriceId) => checkout.mutate(planPriceId)}
                pending={checkout.isPending}
                error={checkout.error}
              />
            )}
          </AsyncState>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Invoices</h2>

        <AsyncState
          isLoading={invoices.isLoading}
          error={invoices.error}
          data={invoices.data}
          onRetry={() => void invoices.refetch()}
          empty={
            <EmptyState
              title="No invoices yet"
              description="Invoices appear here once a payment has been taken."
              action={null}
            />
          }
        >
          {(rows) => <InvoiceTable rows={rows} />}
        </AsyncState>
      </section>
    </div>
  );
}

/** The plan, its price, and whatever the merchant most needs to know about it. */
function CurrentPlan({
  summary,
  canManage,
  onOpenPortal,
  portalPending,
  portalError,
}: {
  summary: SubscriptionSummary;
  canManage: boolean;
  onOpenPortal: () => void;
  portalPending: boolean;
  portalError: unknown;
}) {
  const price =
    summary.amountMinor === null || summary.currency === null
      ? null
      : `${formatMoney(summary.amountMinor, summary.currency)}${
          summary.interval === null ? '' : ` / ${summary.interval}`
        }`;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-muted-foreground text-sm">Current plan</p>
            <p className="text-xl font-semibold">{summary.planName}</p>
          </div>
          {price !== null && <p className="text-lg">{price}</p>}
        </div>

        <StatusNotice summary={summary} />

        <UsageSection usage={summary.usage} />

        {canManage && (
          <div className="space-y-2">
            <Button onClick={onOpenPortal} disabled={portalPending}>
              {portalPending ? 'Opening…' : 'Manage payment method'}
            </Button>

            {portalError !== null && <ErrorState error={portalError} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The one thing about this subscription that needs saying.
 *
 * 📌 **One notice, ordered by urgency.** A screen that stacks every possible
 * banner teaches a merchant to skip all of them; the settling state matters
 * more than a renewal date, and a grace deadline matters more than either.
 */
/**
 * What the tenant uses against what the plan allows (M24.4).
 *
 * 🔴 **The over-limit banner is the milestone's actual deliverable.** M24.4
 * asks to *"prompt for explicit choices about what to disable"*, and a prompt
 * is a UI act: the server shipped the numbers, and until this rendered them a
 * downgraded merchant was refused on create and never told what they were over
 * on.
 *
 * ⚠️ **It never offers to delete anything.** The same milestone says *"never
 * silently delete merchant work"* — a button here that removed the excess would
 * be that deletion with a dialog in front of it. The merchant is told which
 * metric and by how much, and acts through the screens they already use.
 */
export function UsageSection({ usage }: { usage: PlanUsage[] }) {
  if (usage.length === 0) {
    return null;
  }

  const over = usage.filter((row) => row.overLimit);

  return (
    <div className="space-y-3">
      {over.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-medium">Your plan no longer covers everything here.</p>
            <p>
              Nothing has been deleted and your storefront keeps working. To make changes
              again, remove{' '}
              {over
                .map((row) => `${row.current - (row.limit ?? 0)} ${row.label}`)
                .join(', and ')}
              {' '}— or upgrade your plan.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-1">
        {usage.map((row) => (
          <div key={row.metric} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{row.label}</span>
            <span className={row.overLimit ? 'font-medium text-destructive' : undefined}>
              {/*
                🔴 **`limit === null` is unlimited, never a ceiling of zero.**
                The same inversion the server guards against — rendering it as
                "3 of 0" would show the most permissive plan as the most
                breached.
              */}
              {row.limit === null ? `${row.current} (unlimited)` : `${row.current} of ${row.limit}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusNotice({ summary }: { summary: SubscriptionSummary }) {
  if (summary.settling) {
    return (
      <Alert>
        <AlertDescription>
          Confirming your payment with our provider. This usually takes a few seconds — the
          page updates on its own.
        </AlertDescription>
      </Alert>
    );
  }

  if (summary.graceEndsAt !== null) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          A payment did not go through. Update your payment method by{' '}
          {formatDate(summary.graceEndsAt) ?? 'the end of the grace period'} to keep editing
          your option sets. Your storefront keeps working either way.
        </AlertDescription>
      </Alert>
    );
  }

  if (summary.cancelAt !== null) {
    return (
      <Alert>
        <AlertDescription>
          This subscription ends on {formatDate(summary.cancelAt) ?? 'its renewal date'}.
        </AlertDescription>
      </Alert>
    );
  }

  if (summary.trialEndsAt !== null && summary.status === 'trialing') {
    return (
      <Alert>
        <AlertDescription>
          Your trial runs until {formatDate(summary.trialEndsAt) ?? 'its end date'}.
        </AlertDescription>
      </Alert>
    );
  }

  if (summary.currentPeriodEnd !== null) {
    return (
      <p className="text-muted-foreground text-sm">
        Renews on {formatDate(summary.currentPeriodEnd) ?? 'the next billing date'}.
      </p>
    );
  }

  return null;
}

/**
 * Cancelling, behind a confirmation.
 *
 * ⚠️ **The reason is optional and says so.** A required field on the way out
 * produces junk answers from people who want the dialog gone — worse than no
 * data, because it looks like data.
 */
function CancelSection({
  summary,
  confirming,
  onConfirming,
  reason,
  onReason,
  onCancel,
  pending,
  error,
}: {
  summary: SubscriptionSummary;
  confirming: boolean;
  onConfirming: (value: boolean) => void;
  reason: string;
  onReason: (value: string) => void;
  onCancel: () => void;
  pending: boolean;
  error: unknown;
}) {
  /* 📌 Nothing to cancel on a free plan, or one already ending. */
  if (summary.status === 'cancelled' || summary.cancelAt !== null) {
    return null;
  }

  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => onConfirming(true)}>
        Cancel subscription
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm">
          Your subscription stays active until{' '}
          {formatDate(summary.currentPeriodEnd) ?? 'the end of the paid term'}. You keep
          everything you have paid for.
        </p>

        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Why are you leaving? (optional)</span>
          <textarea
            className="border-input bg-background w-full rounded-md border p-2 text-sm"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => onReason(event.target.value)}
          />
        </label>

        {error !== null && <ErrorState error={error} />}

        <div className="flex gap-2">
          <Button variant="destructive" onClick={onCancel} disabled={pending}>
            {pending ? 'Cancelling…' : 'Confirm cancellation'}
          </Button>
          <Button variant="ghost" onClick={() => onConfirming(false)} disabled={pending}>
            Keep my subscription
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Invoice history.
 *
 * 🔴 **`hostedUrl` goes to the provider's own document.** A tax-compliant PDF
 * is the provider's output; re-rendering one here would mean two documents for
 * one charge that must agree forever.
 */
function InvoiceTable({ rows }: { rows: InvoiceSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Tax</th>
            <th className="py-2 pr-4 font-medium">Total</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((invoice) => (
            <tr key={invoice.id} className="border-border border-t">
              <td className="py-2 pr-4">{formatDate(invoice.issuedAt) ?? '—'}</td>
              <td className="py-2 pr-4 capitalize">{invoice.status}</td>
              <td className="py-2 pr-4">{formatMoney(invoice.taxMinor, invoice.currency)}</td>
              <td className="py-2 pr-4">{formatMoney(invoice.totalMinor, invoice.currency)}</td>
              <td className="py-2">
                {invoice.hostedUrl !== null && (
                  <a
                    className="underline underline-offset-4"
                    href={invoice.hostedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What a merchant may move to (M22.5).
 *
 * 🔴 **One card per plan, one button per interval.** Monthly and yearly are
 * different `plan_prices` rows, and checkout takes a price — collapsing them to
 * a single "Choose" would make the UI pick a billing period on the merchant's
 * behalf, which is a decision about their money.
 */
function PlanPicker({
  plans,
  currentPlanCode,
  onChoose,
  pending,
  error,
}: {
  plans: PurchasablePlan[];
  currentPlanCode: string;
  onChoose: (planPriceId: string) => void;
  pending: boolean;
  error: unknown;
}) {
  return (
    <div className="space-y-3">
      {error !== null && <ErrorState error={error} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.code === currentPlanCode;

          return (
            <Card key={plan.id} className={isCurrent ? 'border-primary' : undefined}>
              <CardContent className="space-y-3 pt-6">
                <div>
                  <p className="font-medium">{plan.name}</p>
                  {isCurrent && (
                    <p className="text-muted-foreground text-xs">Your current plan</p>
                  )}
                </div>

                <div className="space-y-2">
                  {plan.prices.map((price) => (
                    <div key={price.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm">
                        {formatMoney(price.amountMinor, price.currency)}
                        <span className="text-muted-foreground"> / {price.interval}</span>
                      </span>

                      {/*
                        📌 A free plan has no provider price, so there is nothing
                        to check out — the card still shows, because a merchant
                        comparing plans needs to see what free includes.
                      */}
                      {price.amountMinor > 0 && !isCurrent && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => onChoose(price.id)}
                        >
                          {pending ? '…' : 'Choose'}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
