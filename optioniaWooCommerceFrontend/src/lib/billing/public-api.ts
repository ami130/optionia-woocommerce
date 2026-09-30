import { api } from '@/lib/api/client';

import type { PurchasablePlan } from './api';

/**
 * The plans on sale, readable without an account.
 *
 * 🔴 **A different ROUTE from the in-app list, but the same source.** The
 * authenticated `GET /billing/plans` requires `BILLING_VIEW`, so a prospect
 * reading a pricing page would get a 401. `GET /plans` is public and calls the
 * same `listPublic()` on the server, so the two cannot disagree about what is
 * for sale.
 *
 * ⚠️ **Typed as `PurchasablePlan`, deliberately reusing the in-app type.** They
 * are the same rows from the same query; a second interface would be a second
 * thing to keep in step for no benefit.
 */
export async function fetchPublicPlans(): Promise<PurchasablePlan[]> {
  const { data } = await api.get<PurchasablePlan[]>('/plans');

  return data;
}
