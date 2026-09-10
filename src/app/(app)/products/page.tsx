'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { AsyncState } from '@/components/layout/states';
import { EmptyCatalogue, ProductRow } from '@/components/products/product-display';
import { useSession } from '@/components/providers/session-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { roleCan } from '@/lib/auth/capabilities';
import { useDebounced } from '@/lib/hooks/use-debounced';
import { listProducts } from '@/lib/products/api';
import { listStores } from '@/lib/stores/api';

/**
 * The synced catalogue (M13.6).
 *
 * Read-only by design. Products are WooCommerce's, imported here so an option
 * set can be assigned to one; editing a name or price on this screen would
 * either be silently overwritten by the next import or write back to a
 * merchant's shop, and neither is something this phase promises.
 */
export default function ProductsPage() {
  const { me } = useSession();
  const [search, setSearch] = useState('');
  const [storeId, setStoreId] = useState<string | null>(null);

  /*
   * 🔴 The input stays instant; only the term that *fetches* waits. Without
   * this every keystroke is a request, and the API's short throttle is 20 per
   * second — so typing a product name answers `429` and replaces the results
   * with "Too many attempts".
   */
  const searchTerm = useDebounced(search);

  const canView = roleCan(me?.role, 'products:view');

  const stores = useQuery({ queryKey: ['stores'], queryFn: listStores, enabled: canView });

  /*
   * A tenant may own several stores and the API requires one, so the first is
   * the default rather than an "all stores" merge: two shops can each hold a
   * product called "T-Shirt" with different ids, and listing them together
   * would offer a choice between two identical-looking rows.
   */
  const selectedStore = storeId ?? stores.data?.[0]?.id ?? null;

  const catalogue = useInfiniteQuery({
    queryKey: ['products', selectedStore, searchTerm],
    enabled: canView && selectedStore !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listProducts({ storeId: selectedStore as string, search: searchTerm, cursor: pageParam }),
    /*
     * Keyset, not offset: the cursor encodes the last row's (name, id), so a
     * product imported mid-scroll cannot shift the window and make a merchant
     * see a row twice or skip one. `undefined` — not `null` — stops the query.
     */
    getNextPageParam: (last) => (last.hasMore ? (last.cursor ?? undefined) : undefined),
  });

  if (!canView) {
    return (
      <Alert>
        <AlertTitle>You do not have access to products</AlertTitle>
        <AlertDescription>Ask an administrator of your workspace for access.</AlertDescription>
      </Alert>
    );
  }

  const items = catalogue.data?.pages.flatMap((page) => page.items);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Products</h1>
        <p className="text-muted-foreground text-sm">
          Imported from your store. Assign option sets to a product from the option set itself.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/*
          🔴 **"Starts with" is not a hedge — it is what the API does.**
          `products.repository.ts` matches `LIKE 'term%'` so the
          `(storeId, name)` index can serve it; `%term%` would scan. Measured on
          seeded data: "Board" returns 0 rows while three products contain the
          word, "Oak Serving Board" among them. A placeholder promising plain
          name search sends a merchant looking for a product they cannot reach
          and leaves them concluding the catalogue is broken. Substring search
          means a FULLTEXT index and a migration — recorded against M19.1.
        */}
        <Input
          value={search}
          placeholder="Search by name — starts with…"
          aria-label="Search products by the start of their name"
          className="max-w-sm"
          onChange={(event) => setSearch(event.target.value)}
        />

        {(stores.data ?? []).length > 1 ? (
          <select
            className="h-9 rounded-md border px-3 text-sm"
            aria-label="Store"
            value={selectedStore ?? ''}
            onChange={(event) => setStoreId(event.target.value)}
          >
            {(stores.data ?? []).map((store) => (
              <option key={store.id} value={store.id}>
                {store.name || store.storeUrl}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/*
       * A tenant with no store has no catalogue *and* nothing to import one
       * from, which is a different problem with a different fix than an import
       * that has not run.
       */}
      {stores.isLoading === false && (stores.data ?? []).length === 0 ? (
        <Alert>
          <AlertTitle>Connect a store first</AlertTitle>
          <AlertDescription>
            Products are imported from WooCommerce. Connect a store to see them here.
          </AlertDescription>
        </Alert>
      ) : (
        <AsyncState
          isLoading={catalogue.isLoading || stores.isLoading}
          /* Stale rows are dimmed while a new term is in flight — see AsyncState. */
          isRefreshing={catalogue.isFetching && !catalogue.isFetchingNextPage}
          error={catalogue.error ?? stores.error}
          data={items}
          onRetry={() => void catalogue.refetch()}
          empty={<EmptyCatalogue searching={searchTerm.trim() !== ''} />}
        >
          {(rows) => (
            <div className="space-y-4">
              <ul className="divide-y rounded-md border">
                {rows.map((product) => (
                  <ProductRow key={product.id} product={product} />
                ))}
              </ul>

              {catalogue.hasNextPage ? (
                <Button
                  variant="outline"
                  disabled={catalogue.isFetchingNextPage}
                  onClick={() => void catalogue.fetchNextPage()}
                >
                  {catalogue.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </div>
          )}
        </AsyncState>
      )}
    </div>
  );
}
