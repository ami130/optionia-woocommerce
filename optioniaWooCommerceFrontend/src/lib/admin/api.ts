import { api } from '@/lib/api/client';

/**
 * Plan administration, as `GET /admin/plans` reports it.
 *
 * 🔴 **The staff realm, not a tenant's.** These routes carry no tenant scope —
 * *"a tenant admin editing what they pay is not a feature, it is a
 * vulnerability"* — and `StaffGuard` authorises every one of them server-side.
 * What the dashboard decides is only whether to RENDER the screen.
 */
export interface AdminPlanPrice {
  id: string;
  currency: string;
  interval: string;
  amountMinor: number;
  /**
   * ⚠️ **Null until `billing:link-prices` creates it at the provider.** A price
   * with no provider id cannot be bought — checkout refuses it — so the screen
   * must say so rather than showing it as live.
   */
  providerPriceId: string | null;
}

export interface AdminPlan {
  id: string;
  code: string;
  name: string;
  /** Whether a NEW signup may choose this plan. Hiding cancels nobody. */
  isPublic: boolean;
  sortOrder: number;
  limits: Record<string, unknown>;
  features: Record<string, boolean>;
  prices: readonly AdminPlanPrice[];
}

/** Every plan, including ones hidden from signup, with their current prices. */
export async function fetchAdminPlans(): Promise<AdminPlan[]> {
  const { data } = await api.get<AdminPlan[]>('/admin/plans');

  return data;
}

export interface DiscountResult {
  priceId: string;
  superseded: string | null;
  listMinor: number;
  amountMinor: number;
  savingMinor: number;
}

/**
 * Discount a plan's yearly list price by a percentage.
 *
 * 📌 **Basis points, not a float.** 2000 is 20%. Money arithmetic here is
 * integer throughout, and a float percentage would reintroduce the drift
 * `PRICING-SPEC.md` §4 exists to prevent — at the one boundary where a staff
 * member sets what merchants pay.
 */
export async function discountPlan(input: {
  code: string;
  currency: string;
  interval: string;
  basisPoints: number;
}): Promise<DiscountResult> {
  const { data } = await api.post<DiscountResult>(
    `/admin/plans/${encodeURIComponent(input.code)}/discount`,
    {
      currency: input.currency,
      interval: input.interval,
      basisPoints: input.basisPoints,
    },
  );

  return data;
}
