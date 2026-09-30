'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';

import { EmptyState, ErrorState, LoadingRows } from '@/components/layout/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/api/error';
import {
  downloadAnalyticsCsv,
  getAnalytics,
  type AnalyticsSummary,
  type Capped,
  type OptionConversion,
  type OptionRevenue,
  type ProductRevenue,
  type RevenueTrend,
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

function Heading({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-muted-foreground text-sm">
          Which of your options earn, and which are being ignored.
        </p>
      </div>
      {children}
    </div>
  );
}

/**
 * Download the export (M25.5).
 *
 * 🔴 **The file is built client-side from a Blob, not linked with an `href`.**
 * The route needs a bearer token, and a plain `<a href>` sends none — so the
 * merchant would get a 401 page instead of a file. Fetching, then clicking a
 * temporary object URL, is what makes an authenticated download possible at all.
 *
 * ⚠️ **`revokeObjectURL` in a `finally`.** An object URL holds the whole blob in
 * memory until it is released, and a merchant exporting repeatedly on a large
 * catalogue would accumulate every copy for the life of the tab.
 */
function ExportButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFailed(null);

    let url: string | null = null;

    try {
      const { blob, filename } = await downloadAnalyticsCsv();

      url = URL.createObjectURL(blob);

      const link = document.createElement('a');

      link.href = url;
      link.download = filename;
      link.click();
    } catch (error) {
      /* The API's own sentence when it has one — it names the plan on a refusal. */
      setFailed(error instanceof Error ? error.message : 'The export could not be produced.');
    } finally {
      if (url !== null) {
        URL.revokeObjectURL(url);
      }

      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 text-right">
      <Button variant="outline" onClick={() => void run()} disabled={busy}>
        {busy ? 'Preparing…' : 'Export CSV'}
      </Button>
      {failed !== null && <p className="text-destructive mt-2 max-w-xs text-xs">{failed}</p>}
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
      {/*
        📌 **Only the populated screen offers the export.** A merchant with no
        orders would download a file containing a header row, which reads as a
        broken feature rather than as an empty shop.
      */}
      <Heading>
        <ExportButton />
      </Heading>

      {currency === null && (
        <Alert>
          <AlertDescription>
            Your orders span more than one currency, so totals are not shown — the
            figures below would not add up to an amount in any single one. Counts
            are still accurate.
          </AlertDescription>
        </Alert>
      )}

      {/*
        📌 **Above the all-time figures, deliberately.** This is the only number
        on the page about *change*, and a merchant who has just adjusted a price
        is looking for it — putting it below four all-time totals buries the one
        answer they came for.
      */}
      <TrendSection trend={data.trend} money={money} />

      <ConversionSection capped={data.conversion} />

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

      {/*
        🔴 **M25.3 asks for most AND least selected values**, and only the second
        was rendered — `topValues` was computed, typed, fixtured and shown to
        nobody. The fourth instance of this project's mechanism-with-no-caller
        defect, found auditing the file that fixed the third.

        ⚠️ **"Highest-earning", not "most-chosen", because that is what it is.**
        `valueRevenue('most')` orders by `revenueMinor DESC` — so a value bought
        twice at a high price outranks one bought fifty times. Calling it
        most-chosen would describe an ordering the query does not use; the
        selection-count view is the least-chosen list below, which orders by
        `orders ASC` for exactly that reason.
      */}
      <RankedSection
        title="Highest-earning values"
        description="Which specific choices bring in the most, within each option."
        capped={data.topValues}
        empty="No value has earned anything yet."
        money={money}
        rowKey={(row) => `${row.optionKey}:${row.valueKey}`}
        name={(row) => `${row.label} — ${row.valueKey}`}
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

      <ProductSection data={data} money={money} />
    </div>
  );
}

/**
 * Whether option revenue is rising or falling (M25.4).
 *
 * 🔴 **The rest of this page is all-time**, so a merchant who raised a price
 * last month sees the months before and after blended into one number — the
 * change they made is invisible in the report built to show it.
 *
 * ⚠️ **Three different absences, three different sentences.** No history that
 * far back, a previous window that earned nothing, and no single currency are
 * distinct situations, and collapsing them into one dash would tell a merchant
 * something false about their shop in at least two of the three.
 */
function TrendSection({
  trend,
  money,
}: {
  trend: RevenueTrend;
  money: (minor: number) => string | null;
}) {
  const current = money(trend.currentMinor);
  const rising = trend.changeFraction !== null && trend.changeFraction > 0;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3">
          <h2 className="font-medium">Option revenue, last {trend.windowDays} days</h2>
          <p className="text-muted-foreground text-sm">
            Compared with the {trend.windowDays} days before that.
          </p>
        </div>

        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold">{current ?? '—'}</span>

          {trend.changeFraction !== null && (
            <span
              className={rising ? 'text-sm font-medium' : 'text-muted-foreground text-sm'}
            >
              {/*
                📌 **The sign is explicit.** "25%" beside a figure is ambiguous
                about direction; "+25%" and "−25%" are not. The minus is a real
                minus sign (U+2212), not a hyphen, because a hyphen at this size
                reads as punctuation.
              */}
              {trend.changeFraction > 0 ? '+' : '−'}
              {Math.abs(Math.round(trend.changeFraction * 100))}%
            </span>
          )}
        </div>

        <p className="text-muted-foreground mt-2 text-xs">{explain(trend, money)}</p>
      </CardContent>
    </Card>
  );
}

/**
 * The sentence under the figure, naming which absence this is.
 *
 * 🔴 **"No history" and "earned nothing" must not share a sentence.** A merchant
 * whose first order was last week has nothing to compare against; one whose
 * options earned nothing last month has a real and actionable zero. Telling the
 * first they fell 100% would be a statement about their tenure, not their shop.
 */
function explain(
  trend: RevenueTrend,
  money: (minor: number) => string | null,
): string {
  if (trend.previousMinor === null) {
    return 'No orders before this period yet, so there is nothing to compare against.';
  }

  const previous = money(trend.previousMinor);

  if (previous === null) {
    /* The currency is not one currency — the counts are still true. */
    return `${trend.currentOrders} orders with options, against ${trend.previousOrders} before.`;
  }

  if (trend.changeFraction === null) {
    /* previousMinor is 0: a real zero, not a missing one. */
    return `Options earned nothing in the previous ${trend.windowDays} days, so there is no percentage to show.`;
  }

  return `${previous} in the previous ${trend.windowDays} days, from ${trend.previousOrders} orders.`;
}

/**
 * Of the customers who saw each option, how many bought it (M25.1, M25.3).
 *
 * 🔴 **The clause F157 recorded as unanswerable, and the reason M25.1 was built.**
 * Conversion needs a denominator of views, and until the plugin release that
 * sends them, nothing recorded one — so this screen shipped average order value
 * as the honest substitute and deliberately never used the word.
 *
 * ⚠️ **An option seen many times and never bought is the most useful row here.**
 * It converts at zero, and it is listed — a dead option with a number attached,
 * which is what a merchant acts on.
 */
function ConversionSection({ capped }: { capped: Capped<OptionConversion> }) {
  return (
    <Section
      title="Conversion by option"
      description="Of the customers who saw each option, how many bought it."
      capped={capped}
    >
      {capped.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {/*
            📌 **Says WHY it is empty, and what closes it.** An empty box would
            read as a broken feature rather than as a plugin release a merchant
            has not installed yet.
          */}
          No views recorded yet. Conversion appears once your store is running a
          plugin version that reports which options customers see.
        </p>
      ) : (
        <ul className="divide-y">
          {capped.rows.map((row) => (
            <li key={row.optionKey} className="flex items-baseline justify-between py-2">
              <span className="truncate pr-4 text-sm">{row.label}</span>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {rateText(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * One option's conversion, or why there is not one.
 *
 * 🔴 **`null` is NOT zero.** An option with orders and no recorded views has a
 * measurement gap; printing 0% would tell a merchant their best-selling option
 * never sells. The two are said differently because they mean different things.
 */
function rateText(row: OptionConversion): string {
  if (row.rate === null) {
    return `${row.orders} orders, views not recorded`;
  }

  return `${Math.round(row.rate * 100)}% — ${row.orders} of ${row.views}`;
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
          ⚠️ **Still not called conversion, and the reason has changed.** This is
          average order value — a comparison of what orders are worth. The true
          conversion figure now exists (M25.1 records views) and has its own
          section below; naming this one conversion would make two different
          measurements share a word.
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

/**
 * What options earned on each product (M25.4, F151).
 *
 * 🔴 **The half of M25.4 that needed a schema change**, and the one a merchant
 * asks first: *"which of my products actually sell better with options?"* It is
 * empty until the plugin release that sends a product reference, which is why
 * the disclosure below is not optional.
 */
function ProductSection({
  data,
  money,
}: {
  data: AnalyticsSummary;
  money: (minor: number) => string | null;
}) {
  return (
    <Section
      title="Revenue by product"
      description="What your options earned on each product you sell."
      capped={data.products}
    >
      {data.products.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {/*
            📌 **Two different emptinesses, one honest sentence.** A shop with no
            orders and a shop whose orders all predate product attribution both
            land here, and the disclosure below distinguishes them — so this line
            must not claim there is nothing to report.
          */}
          No orders yet carry the information needed to attribute revenue to a
          product.
        </p>
      ) : (
        <ul className="divide-y">
          {data.products.rows.map((row) => (
            <li key={row.productRef} className="flex items-baseline justify-between py-2">
              <span className="truncate pr-4 text-sm">{productName(row)}</span>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {money(row.revenueMinor) ?? `${row.orders} orders`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        🔴 **Said out loud, because the figures above are otherwise read as the
        merchant's whole catalogue.** Orders placed before the plugin update
        carry no product and nothing can backfill them — the third such boundary
        date, after F146's quantity fix and F150's set attribution.
      */}
      {data.unattributedProductSelections > 0 && (
        <p className="text-muted-foreground mt-3 text-xs">
          {data.unattributedProductSelections} earlier selections were placed
          before Optionia recorded which product they were for, so they are not
          counted above.
        </p>
      )}
    </Section>
  );
}

/**
 * What to call a product the catalogue may not know.
 *
 * ⚠️ **The id is shown when the name is missing, never "Unknown".** A merchant
 * who has not synced, or who deleted the product after the order, still earned
 * that money — and an id they can search for in WooCommerce is actionable where
 * a placeholder is not.
 */
function productName(row: ProductRevenue): string {
  return row.name ?? `Product ${row.productRef}`;
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
