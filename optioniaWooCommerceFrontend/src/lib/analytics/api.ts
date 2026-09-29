import { getAccessToken } from '@/lib/auth/token-store';
import { API_BASE_URL, api } from '@/lib/api/client';
import { ApiError, NetworkError } from '@/lib/api/error';

/**
 * A capped list, and how much of the truth it represents.
 *
 * 🔴 **`total` is not decoration.** The API returns at most fifty rows, and
 * fifty rows with no total is indistinguishable from "that is everything" — so a
 * merchant with a large catalogue would read a partial list as complete, and
 * "least selected" would name values that are not least selected.
 */
export interface Capped<T> {
  rows: T[];
  total: number;
  truncated: boolean;
}

/** One option, and what it earned. */
export interface OptionRevenue {
  optionKey: string;
  /** The most recent name a customer saw — labels are snapshotted per order. */
  label: string;
  revenueMinor: number;
  orders: number;
}

/** One chosen value, and how often it was chosen. */
export interface ValueRevenue {
  optionKey: string;
  valueKey: string;
  label: string;
  revenueMinor: number;
  orders: number;
}

/** An option in the merchant's configuration that no customer has ever chosen. */
export interface DeadOption {
  optionSetId: string;
  optionSetName: string;
  optionKey: string;
  label: string;
}

/** What one option set earned. */
export interface OptionSetRevenue {
  optionSetId: string;
  name: string;
  revenueMinor: number;
  orders: number;
}

/**
 * How many orders carried options, and what they were worth.
 *
 * ⚠️ **This is not conversion.** M25.3 names *"conversion with vs. without
 * options"*, which needs a denominator of visits — and nothing records a view.
 * The two averages are the honest substitute from data that exists.
 */
export interface AttachRate {
  orders: number;
  ordersWithOptions: number;
  /** 0–1, or `null` when there are no orders to divide by. */
  rate: number | null;
  optionRevenueMinor: number;
  totalRevenueMinor: number;
  /** `null` when there are no such orders — an average of nothing is not zero. */
  averageOrderValueWithOptionsMinor: number | null;
  averageOrderValueWithoutOptionsMinor: number | null;
}

/** Everything `GET /analytics` returns. */
export interface AnalyticsSummary {
  attach: AttachRate;
  topOptions: Capped<OptionRevenue>;
  topValues: Capped<ValueRevenue>;
  leastValues: Capped<ValueRevenue>;
  deadOptions: Capped<DeadOption>;
  optionSets: Capped<OptionSetRevenue>;
  /**
   * Selections placed before the plugin sent a set id, and unattributable
   * forever. Shown beside the per-set figures so a partial total is not read as
   * a complete one.
   */
  unattributedSelections: number;
  /**
   * The currency every figure here is in, or `null` when it is not one.
   *
   * 🔴 **Minor units alone cannot be displayed.** `4700` is £47.00 or ¥4700
   * depending on the currency. When this is `null` the tenant's orders span
   * several, so the totals are sums across them and are **not** an amount in
   * any single currency — the page shows counts and withholds money rather than
   * mislabelling it.
   */
  currency: string | null;
}

export async function getAnalytics(): Promise<AnalyticsSummary> {
  const { data } = await api.get<AnalyticsSummary>('/analytics');

  return data;
}

/**
 * Download the option-revenue export as a file (M25.5).
 *
 * ## Why this bypasses `api`
 *
 * 📌 **`api.get` unwraps a `{data, meta}` envelope**, and this route returns raw
 * CSV — there is no envelope to unwrap. Passing it through would either parse
 * the file as JSON and throw, or need the client to grow a second return shape
 * that only one caller uses.
 *
 * ⚠️ **It still sends the same bearer token from the same store**, so a signed
 * out merchant is refused here exactly as everywhere else. What it does not
 * inherit is the refresh-on-401 retry, which is deliberate: a download that
 * silently re-authenticated mid-click would save the file after the browser had
 * already given up on it.
 *
 * 🔴 **The filename comes from the server**, not from here. It carries the date
 * so a merchant exporting twice in a month can tell the two apart, and
 * duplicating that string on this side is how the two drift.
 */
export async function downloadAnalyticsCsv(): Promise<{ blob: Blob; filename: string }> {
  const token = getAccessToken();

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}/analytics/export`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!response.ok) {
    /*
     * The body is JSON on an error even though success is CSV — the exception
     * filter answers in the envelope whatever the route would have returned.
     * A plan refusal has to reach the caller as `PLAN_FEATURE_UNAVAILABLE`, or
     * the page cannot tell "upgrade" from "something broke".
     */
    const body = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;

    throw new ApiError(
      response.status,
      body?.error ?? { code: 'INTERNAL_ERROR', message: 'The export could not be produced.' },
    );
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition);

  return {
    blob: await response.blob(),
    filename: named?.[1] ?? 'optionia-option-revenue.csv',
  };
}
