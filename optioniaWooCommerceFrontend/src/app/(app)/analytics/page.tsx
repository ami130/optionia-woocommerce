'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { EmptyState, ErrorState, LoadingRows } from '@/components/layout/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/api/error';
import {
  getAnalytics,
  type AnalyticsSummary,
  type Capped,
  type OptionRevenue,
  type ValueRevenue,
} from '@/lib/analytics/api';
import { formatMoney } from '@/lib/billing/format';

/**
 * What a merchant's options actually earned (M25.3).
 *
 * ## Why this page exists
 *
 * 🔴 **The backend was complete, tested and unreachable — the tenth time.**
 * `GET /analytics` shipped with twenty e2e tests and no screen, so a merchant
 * could not see which of their options earn and which are dead. The same defect
 * as F132 (the dashboard ignored `usage[]`) and F137 (`plan.read_only` unread by
 * the plugin), and **Phase 25's exit criterion says "a merchant can identify
 * their highest-revenue options and their dead ones"** — the subject is the
 * merchant, not the API.
 *
 * ## The two states that are not errors
 *
 * ⚠️ **A plan without analytics is an upgrade prompt, not a failure.** The API
 * answers `403 PLAN_FEATURE_UNAVAILABLE` with a sentence naming the plan that
 * would help; rendering that as a red error would tell a Free merchant their
 * dashboard is broken.
 *
 * ⚠️ **No orders yet is an empty state, not zero.** A shop that has not sold
 * anything has no analytics, and showing "£0.00 earned" invites the conclusion
 * that the options do not work.
 */
export default function AnalyticsPage() {
  const analytics = useQuery({
    queryKey: ['analytics', 'summary'],
    queryFn: getAnalytics,

    /*
     * 📌 **No retry on a plan refusal.** It is a settled answer, not a blip, and
     * retrying it three times delays the upgrade prompt for no gain.
     */
    retry: (count, error) =>
      error instanceof ApiError && error.status === 403 ? false : count < 2,
  });

  if (analytics.isLoading) {
    return (
      <div className="space-y-6">
        <Heading />
        <LoadingRows rows={4} />
      </div>
    );
  }

  const planRefusal =
    analytics.error instanceof ApiError &&
    analytics.error.code === 'PLAN_FEATURE_UNAVAILABLE'
      ? analytics.error
      : null;

  if (planRefusal) {
    return (
      <div className="space-y-6">
        <Heading />
        <Card>
          <CardContent className="space-y-4 pt-6">
            {/* The API's own sentence: it names the plan that includes this. */}
            <p className="text-muted-foreground text-sm">{planRefusal.message}</p>
            {/* This Button takes no `asChild`, so the link wraps it. */}
            <Link href="/subscription">
              <Button>See plans</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  /*
   * ⚠️ **`data === undefined` written out, not `!data`.** This screen branches by
   * hand rather than through `AsyncState`, so it has to narrow `data` itself —
   * and `screen-states.test.ts` checks for exactly this shape, because a screen
   * testing only `error` leaves a settled-but-empty path that renders the
   * populated view over missing data. That was the `/connect` defect.
   */
  if (analytics.error || analytics.data === undefined) {
    return (
      <div className="space-y-6">
        <Heading />
        <ErrorState error={analytics.error} onRetry={() => void analytics.refetch()} />
      </div>
    );
  }

  return <Summary data={analytics.data} />;
}

function Heading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Analytics</h1>
      <p className="text-muted-foreground text-sm">
        Which of your options earn, and which are being ignored.
      </p>
    </div>
  );
}

/**
 * Exported for its render tests.
 *
 * 🔴 **The defect this page fixes was that nothing put these numbers on
 * screen**, so a test reading the same object the component reads would have
 * passed throughout. The tests render.
 */
export function Summary({ data }: { data: AnalyticsSummary }) {
  const { attach, currency } = data;

  /*
   * 🔴 **Money is withheld when the currency is not one currency.** Every figure
   * is a sum of minor units; across two currencies that sum is not an amount in
   * either, and labelling it with one would make a meaningless number look
   * meaningful. Counts stay — an option chosen forty times was chosen forty
   * times whatever it was priced in.
   */
  const money = (minor: number): string | null =>
    currency === null ? null : formatMoney(minor, currency);

  if (attach.orders === 0) {
    return (
      <div className="space-y-6">
        <Heading />
        <EmptyState
          title="No orders yet"
          description="Once customers start buying, this page shows which options earn the most and which are never chosen."
          action={
            /*
             * 📌 **Pointing at option sets, not at a retry.** A merchant with no
             * orders has nothing to reload — what they can act on is publishing
             * the options that would produce some.
             */
            <Link href="/option-sets">
              <Button variant="outline">Review your option sets</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Heading />

      {currency === null && (
        <Alert>
          <AlertDescription>
            Your orders span more than one currency, so totals are not shown — the
            figures below would not add up to an amount in any single one. Counts
            are still accurate.
          </AlertDescription>
        </Alert>
      )}

      <AttachSection attach={attach} money={money} />

      <RankedSection
        title="Highest-earning options"
        description="Where your option revenue actually comes from."
        capped={data.topOptions}
        empty="No option has earned anything yet."
        money={money}
        rowKey={(row) => row.optionKey}
        name={(row) => row.label}
      />

      <RankedSection
        title="Least-chosen values"
        description="Ordered by how often each was picked, not by what it earned."
        capped={data.leastValues}
        empty="No values to compare yet."
        money={money}
        rowKey={(row) => `${row.optionKey}:${row.valueKey}`}
        name={(row) => `${row.label} — ${row.valueKey}`}
      />

      <DeadSection capped={data.deadOptions} />

      <SetSection data={data} money={money} />
    </div>
  );
}

function AttachSection({
  attach,
  money,
}: {
  attach: AnalyticsSummary['attach'];
  money: (minor: number) => string | null;
}) {
  const withOptions = attach.averageOrderValueWithOptionsMinor;
  const withoutOptions = attach.averageOrderValueWithoutOptionsMinor;

  return (
    <Card>
      <CardContent className="grid gap-6 pt-6 sm:grid-cols-3">
        <Figure
          label="Orders using options"
          value={
            attach.rate === null ? '—' : `${Math.round(attach.rate * 100)}%`
          }
          note={`${attach.ordersWithOptions} of ${attach.orders}`}
        />

        {/*
          ⚠️ **This is deliberately NOT called conversion.** M25.3 names
          "conversion with vs. without options", which needs a denominator of
          visits — and nothing records a view. Calling an order-value comparison
          "conversion" would be a claim the data does not support.
        */}
        <Figure
          label="Average order, with options"
          {...average(withOptions, money, 'No such orders yet')}
        />
        <Figure
          label="Average order, without"
          {...average(withoutOptions, money, 'Every order used options')}
        />
      </CardContent>
    </Card>
  );
}

/**
 * An average order value, and why it is absent when it is.
 *
 * 🔴 **A `null` currency must NOT fall through to the raw number** (F161). Every
 * figure here is in **minor units**, so `9000` means £90.00 — and printing it
 * bare is exactly the mislabelling the currency field was added to prevent. I
 * shipped that fallback one function below the guard that forbids it.
 *
 * ⚠️ **Two different reasons produce a dash, and they need different notes.**
 * *No orders of this kind* is a fact about the shop; *no single currency* is a
 * fact about what can be displayed. Collapsing them would tell a merchant with
 * plenty of option orders that they have none.
 */
function average(
  minor: number | null,
  money: (minor: number) => string | null,
  emptyNote: string,
): { value: string; note?: string } {
  if (minor === null) {
    return { value: '—', note: emptyNote };
  }

  const formatted = money(minor);

  if (formatted === null) {
    return { value: '—', note: 'Shown only in a single currency' };
  }

  return { value: formatted };
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-sm">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {note !== undefined && <p className="text-muted-foreground text-xs">{note}</p>}
    </div>
  );
}

/** A revenue-ranked list, used for both options and values. */
function RankedSection<T extends OptionRevenue | ValueRevenue>({
  title,
  description,
  capped,
  empty,
  money,
  rowKey,
  name,
}: {
  title: string;
  description: string;
  capped: Capped<T>;
  empty: string;
  money: (minor: number) => string | null;
  rowKey: (row: T) => string;
  name: (row: T) => string;
}) {
  return (
    <Section title={title} description={description} capped={capped}>
      {capped.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="divide-y">
          {capped.rows.map((row) => (
            <li key={rowKey(row)} className="flex items-baseline justify-between py-2">
              <span className="truncate pr-4 text-sm">{name(row)}</span>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {/*
                  Formatted once. The earlier form called `money()` twice per row
                  to decide whether to print a separator, which is the same
                  question asked twice and drifts the moment one changes.
                */}
                {[money(row.revenueMinor), `${row.orders} ${row.orders === 1 ? 'order' : 'orders'}`]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DeadSection({ capped }: { capped: Capped<AnalyticsSummary['deadOptions']['rows'][number]> }) {
  return (
    <Section
      title="Options nobody has chosen"
      description="These exist in your configuration and no customer has ever picked them."
      capped={capped}
    >
      {capped.rows.length === 0 ? (
        /* 🔴 The good outcome, said plainly rather than left as an empty box. */
        <p className="text-muted-foreground text-sm">
          Every option you have published has been chosen at least once.
        </p>
      ) : (
        <ul className="divide-y">
          {capped.rows.map((row) => (
            <li key={`${row.optionSetId}:${row.optionKey}`} className="py-2 text-sm">
              <span>{row.label}</span>
              <span className="text-muted-foreground"> — {row.optionSetName}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SetSection({
  data,
  money,
}: {
  data: AnalyticsSummary;
  money: (minor: number) => string | null;
}) {
  return (
    <Section
      title="Revenue by option set"
      description="What each set has earned across your orders."
      capped={data.optionSets}
    >
      {data.optionSets.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No orders yet carry the information needed to attribute revenue to a set.
        </p>
      ) : (
        <ul className="divide-y">
          {data.optionSets.rows.map((row) => (
            <li key={row.optionSetId} className="flex items-baseline justify-between py-2">
              <span className="truncate pr-4 text-sm">{row.name}</span>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {money(row.revenueMinor) ?? `${row.orders} orders`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        🔴 **Said out loud, because the figures above are otherwise misread as
        complete.** Orders placed before the plugin update carry no set, and
        nothing can backfill them — so a merchant comparing two sets needs to
        know how much sits outside the comparison entirely.
      */}
      {data.unattributedSelections > 0 && (
        <p className="text-muted-foreground mt-3 text-xs">
          {data.unattributedSelections} earlier selections were placed before
          Optionia recorded which set they came from, so they are not counted
          above.
        </p>
      )}
    </Section>
  );
}

function Section({
  title,
  description,
  capped,
  children,
}: {
  title: string;
  description: string;
  capped: Capped<unknown>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3">
          <h2 className="font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>

        {children}

        {/*
          ⚠️ **A capped list says so.** Fifty rows and "that is everything" are
          indistinguishable otherwise, and the merchant would read a partial list
          as their whole catalogue.
        */}
        {capped.truncated && (
          <p className="text-muted-foreground mt-3 text-xs">
            Showing {capped.rows.length} of {capped.total}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
