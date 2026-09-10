import { api } from '@/lib/api/client';

/**
 * A product as the catalogue reports it.
 *
 * ⚠️ **Two ids, and only one of them assigns.** `id` is ours and stable across a
 * sync; `externalId` is **WooCommerce's**, and it is what an assignment's
 * `targetRef` stores. Sending the wrong one writes cleanly, passes every
 * frontend test, and produces an assignment the plugin never resolves — because
 * it indexes by an id that does not exist on that site.
 *
 * Stage 0's ownership check catches a *foreign* id, but not our own row id for
 * the right product: that is a valid string the API has no way to reject. So the
 * distinction is asserted in `api.test.ts`, because nothing else will.
 */
export interface Product {
  id: string;
  externalId: string;
  name: string;
  sku: string | null;
  type: string;
  priceMinor: number | null;
  status: string;
  permalink: string | null;
  imageUrl: string | null;
}

export interface ProductPage {
  items: Product[];
  /** Opaque. Echo it back verbatim; never construct one. */
  cursor: string | null;
  hasMore: boolean;
}

/**
 * One page of a store's catalogue.
 *
 * `storeId` is required by the API rather than inferred: a tenant may own
 * several stores, and merging their catalogues would present two products with
 * the same name on two storefronts as though they were interchangeable.
 */
export async function listProducts(input: {
  storeId: string;
  search?: string;
  cursor?: string;
  limit?: number;
}): Promise<ProductPage> {
  const { data, meta } = await api.get<Product[]>('/products', {
    query: {
      storeId: input.storeId,
      // An empty search is no search: sending `search=` would filter on the
      // empty prefix, which matches everything but costs a `LIKE` to say so.
      search: input.search?.trim() === '' ? undefined : input.search,
      cursor: input.cursor,
      limit: input.limit,
    },
  });

  return {
    items: data,
    cursor: meta.pagination?.cursor ?? null,
    hasMore: meta.pagination?.hasMore ?? false,
  };
}
