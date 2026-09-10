'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AsyncState, ErrorState } from '@/components/layout/states';
import { EmptyCatalogue, ProductRow } from '@/components/products/product-display';
import { useSession } from '@/components/providers/session-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { roleCan } from '@/lib/auth/capabilities';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  assignProducts,
  listAssignments,
  unassignProduct,
  type AssignmentView,
} from '@/lib/option-sets/api';
import { listProducts } from '@/lib/products/api';

/**
 * Which products an option set applies to (M13.6).
 *
 * ## The id that assigns is not the id that identifies
 *
 * Assignments target `externalId` — WooCommerce's id — never our row `id`. Both
 * are on every product and both are strings, so sending the wrong one type-checks,
 * writes cleanly, returns 200, and produces an assignment the plugin can never
 * resolve. Every call below spells out which id it is passing for that reason.
 */
export function ProductPicker({
  optionSetId,
  storeId,
  isDraft,
}: {
  optionSetId: string;
  storeId: string;
  /** A draft's assignments are stored but change nothing until it is published. */
  isDraft: boolean;
}) {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');

  /* 🔴 One request per settled term, not one per keystroke — see `useDebounced`. */
  const searchTerm = useDebounced(search);

  const canAssign = roleCan(me?.role, 'products:assign');

  const assignments = useQuery({
    queryKey: ['option-set', optionSetId, 'assignments'],
    queryFn: () => listAssignments(optionSetId),
  });

  /*
   * ⚠️ **Namespaced `'picker'` on purpose.** `/products` caches the same store
   * and term under `['products', storeId, term]` as an *infinite* query, whose
   * value is `{pages: [...]}` — not a `ProductPage`. TanStack v5 keys one cache
   * entry per key regardless of which hook wrote it, so sharing the key would
   * hand whichever screen mounted second the other's shape, and `data.items`
   * would be `undefined`. They are separate routes today; this keeps that from
   * mattering the day one embeds the other.
   */
  const catalogue = useQuery({
    queryKey: ['products', 'picker', storeId, searchTerm],
    queryFn: () => listProducts({ storeId, search: searchTerm }),
    enabled: canAssign,
  });

  /*
   * Both writes return the resulting list, but it is the *cache* that the two
   * panels read, and the catalogue's "Assigned" state is derived from it.
   * Invalidating keeps one source of truth rather than two that can disagree.
   */
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['option-set', optionSetId, 'assignments'] });

  const assign = useMutation({
    mutationFn: (externalId: string) => assignProducts(optionSetId, [externalId]),
    onSuccess: refresh,
  });

  const unassign = useMutation({
    mutationFn: (externalId: string) => unassignProduct(optionSetId, externalId),
    onSuccess: refresh,
  });

  const assigned = new Set(
    (assignments.data ?? []).map((row) => row.targetRef).filter((ref): ref is string => ref !== null),
  );

  return (
    <section className="space-y-4">
      <h2 className="font-medium">Products</h2>

      {/*
       * 🔴 An assignment on a draft changes nothing a customer can see: the
       * config document is built from published snapshots only. Without saying
       * so, a merchant assigns a product, sees it listed, checks the storefront,
       * and finds nothing — with no way to tell that from a broken assignment.
       */}
      {isDraft ? (
        <Alert>
          <AlertDescription>
            This option set is still a draft. Assignments are saved now and reach your storefront
            when you publish it.
          </AlertDescription>
        </Alert>
      ) : null}

      <AsyncState
        isLoading={assignments.isLoading}
        isRefreshing={assignments.isFetching}
        error={assignments.error}
        data={assignments.data}
        onRetry={() => void assignments.refetch()}
        empty={
          <p className="text-muted-foreground text-sm">
            Not assigned to any product yet, so it will not appear on your storefront.
          </p>
        }
      >
        {(rows) => (
          <ul className="divide-y rounded-md border">
            {rows.map((row) => (
              <AssignedRow
                key={row.id}
                row={row}
                canAssign={canAssign}
                isBusy={unassign.isPending}
                onRemove={(externalId) => unassign.mutate(externalId)}
              />
            ))}
          </ul>
        )}
      </AsyncState>

      {unassign.error === null ? null : <ErrorState error={unassign.error} />}

      {canAssign ? (
        <div className="space-y-3 border-t pt-4">
          {/* Starts-with, not substring — see the note on `/products`. */}
          <Input
            value={search}
            placeholder="Search your catalogue — starts with…"
            aria-label="Search products by the start of their name"
            onChange={(event) => setSearch(event.target.value)}
          />

          <AsyncState
            isLoading={catalogue.isLoading}
            isRefreshing={catalogue.isFetching}
            error={catalogue.error}
            data={catalogue.data?.items}
            onRetry={() => void catalogue.refetch()}
            empty={<EmptyCatalogue searching={searchTerm.trim() !== ''} />}
          >
            {(items) => (
              <ul className="divide-y rounded-md border">
                {items.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={assigned.has(product.externalId) || assign.isPending}
                        /* WooCommerce's id — never `product.id`. */
                        onClick={() => assign.mutate(product.externalId)}
                      >
                        {assigned.has(product.externalId) ? 'Assigned' : 'Assign'}
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </AsyncState>

          {catalogue.data?.hasMore ? (
            <p className="text-muted-foreground text-xs">
              More products match than are shown. Narrow the search to find a specific one.
            </p>
          ) : null}

          {assign.error === null ? null : <ErrorState error={assign.error} />}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One current assignment.
 *
 * The name is joined server-side, so `null` means the product is not in the
 * catalogue — deleted upstream, or not yet imported. Saying that plainly is the
 * point: the option has silently stopped rendering while this list still claims
 * it applies, and the WooCommerce id alone would not tell a merchant why.
 */
function AssignedRow({
  row,
  canAssign,
  isBusy,
  onRemove,
}: {
  row: AssignmentView;
  canAssign: boolean;
  isBusy: boolean;
  onRemove: (externalId: string) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 p-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-medium">{row.productName ?? row.targetRef}</span>

        {row.productName === null ? (
          <span className="text-destructive text-xs">No longer in your catalogue</span>
        ) : row.productStatus !== 'publish' ? (
          <span className="text-muted-foreground text-xs">
            {row.productStatus} — not visible on your storefront
          </span>
        ) : null}
      </span>

      {canAssign && row.targetRef !== null ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={isBusy}
          onClick={() => onRemove(row.targetRef as string)}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}
