'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AsyncState, ErrorState } from '@/components/layout/states';
import { AssignedRow, EmptyCatalogue, ProductRow } from '@/components/products/product-display';
import { useSession } from '@/components/providers/session-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { invalidateActivation } from '@/lib/activation/cache';
import { roleCan } from '@/lib/auth/capabilities';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  ASSIGNMENT_TARGET_TYPES,
  TARGET_TYPE_LABELS,
  assignProducts,
  assignTargets,
  listAssignments,
  previewTarget,
  unassignTarget,
  unassignTargets,
  type AssignmentTarget,
  type AssignmentTargetType,
} from '@/lib/option-sets/api';
import { chunk } from '@/lib/option-sets/bulk';
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

  /* The non-product target a merchant is composing: its type, and its reference. */
  const [targetType, setTargetType] = useState<AssignmentTargetType>('category');
  const [targetRef, setTargetRef] = useState('');

  /*
   * 🔴 **Selected products, keyed by WooCommerce's `externalId`.** That is what
   * an assignment stores, so keying on the mirror's row `id` would mean
   * translating on every apply — and the translation is exactly where a
   * "selected 40, assigned 39" bug lives.
   *
   * Kept across a search change on purpose: narrowing the search to find the
   * next product is part of building one selection, and clearing it there would
   * silently discard work a merchant could not see happening.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

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
  /**
   * Assigning or unassigning moves the funnel's `assigned` step, so the
   * dashboard checklist is refreshed alongside this screen's own list.
   */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['option-set', optionSetId, 'assignments'] });
    invalidateActivation(queryClient);
  };

  const assign = useMutation({
    mutationFn: (externalId: string) => assignProducts(optionSetId, [externalId]),
    onSuccess: refresh,
  });

  /** Assigning a category, tag, attribute or price band by reference (M19.1'). */
  const assignTarget = useMutation({
    mutationFn: (target: AssignmentTarget) => assignTargets(optionSetId, [target]),
    onSuccess: () => {
      setTargetRef('');
      refresh();
    },
  });

  const unassign = useMutation({
    mutationFn: (target: AssignmentTarget) => unassignTarget(optionSetId, target),
    onSuccess: refresh,
  });

  /**
   * Assign every selected product (M19.5).
   *
   * ⚠️ **Chunked at the API's own cap.** `AssignTargetsDto` accepts 100 targets
   * per request, and a selection can exceed that. The chunks run in sequence
   * rather than in parallel: each one bumps `configVersion`, and the response
   * the merchant sees should be the last state, not whichever raced last.
   *
   * 🔴 **Safe to retry, because assign is idempotent.** The service upserts
   * with `ON DUPLICATE KEY UPDATE` — written precisely so a double-click cannot
   * turn into a 409 — so a chunk replayed after a network error cannot create
   * duplicates or fail.
   */
  const assignSelected = useMutation({
    mutationFn: async (externalIds: string[]) => {
      for (const batch of chunk(externalIds)) {
        await assignProducts(optionSetId, batch);
      }
    },
    onSuccess: () => {
      setSelected(new Set());
      refresh();
    },
  });

  /** Unassign every selected product (M19.5). */
  const unassignSelected = useMutation({
    mutationFn: async (externalIds: string[]) => {
      for (const batch of chunk(externalIds)) {
        await unassignTargets(
          optionSetId,
          batch.map((externalId) => ({
            targetType: 'product' as const,
            targetRef: externalId,
          })),
        );
      }
    },
    onSuccess: () => {
      setSelected(new Set());
      refresh();
    },
  });

  /**
   * How many products the typed target would apply to (M19.5).
   *
   * ⚠️ **Only for a reference the merchant has finished typing.** `targetRef`
   * is debounced before it reaches here, so this does not fire a request per
   * keystroke.
   *
   * 📌 The count is an **estimate** for a taxonomy — the mirror is a snapshot
   * and the storefront resolves live — which is why the wording below says
   * "about" rather than stating a number as fact.
   */
  const previewRef = useDebounced(targetRef.trim(), 300);

  const targetCount = useQuery({
    queryKey: ['option-set', optionSetId, 'preview', targetType, previewRef],
    queryFn: () => previewTarget(optionSetId, { targetType, targetRef: previewRef }),
    enabled: canAssign && previewRef !== '',
  });

  /** Add or remove one product from the selection. */
  const toggle = (externalId: string) =>
    setSelected((current) => {
      const next = new Set(current);

      if (!next.delete(externalId)) {
        next.add(externalId);
      }

      return next;
    });

  /*
   * 🔴 **Keyed by `type:ref`, not by `ref` alone.** `targetRef` is unique only
   * *within* a type, so a bare-reference set would mark product `12` assigned
   * because category `12` is — and grey out the button for a product the
   * merchant has not assigned.
   */
  const assigned = new Set(
    (assignments.data ?? [])
      .filter((row) => row.targetRef !== null)
      .map((row) => `${row.targetType ?? 'product'}:${row.targetRef ?? ''}`),
  );

  return (
    <section className="space-y-4">
      <h2 className="font-medium">Assigned to</h2>

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
            Not assigned to anything yet, so it will not appear on your storefront.
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
                onRemove={(target) => unassign.mutate(target)}
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
              <>
                {/*
                  * The bulk bar (M19.5).
                  *
                  * 🔴 **"Select all" means all on THIS page, and says so.** The
                  * catalogue is paged and the search is a prefix match, so a
                  * control labelled plainly "Select all" would promise the
                  * whole catalogue and deliver 25 rows. `hasMore` above already
                  * tells a merchant more exist; this must not contradict it.
                  */}
                <div className="flex flex-wrap items-center gap-3 pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      /*
                       * Checked only when every row on the page is selected;
                       * an empty page is never "all selected".
                       */
                      checked={
                        items.length > 0 &&
                        items.every((product) => selected.has(product.externalId))
                      }
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);

                          for (const product of items) {
                            if (event.target.checked) {
                              next.add(product.externalId);
                            } else {
                              next.delete(product.externalId);
                            }
                          }

                          return next;
                        })
                      }
                    />
                    Select all on this page
                  </label>

                  {selected.size === 0 ? null : (
                    <>
                      <span className="text-muted-foreground text-sm tabular-nums">
                        {selected.size} selected
                      </span>

                      <Button
                        size="sm"
                        disabled={assignSelected.isPending || unassignSelected.isPending}
                        onClick={() => assignSelected.mutate([...selected])}
                      >
                        Assign selected
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={assignSelected.isPending || unassignSelected.isPending}
                        onClick={() => unassignSelected.mutate([...selected])}
                      >
                        Unassign selected
                      </Button>

                      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                        Clear
                      </Button>
                    </>
                  )}
                </div>

                {assignSelected.error === null ? null : (
                  <ErrorState error={assignSelected.error} />
                )}
                {unassignSelected.error === null ? null : (
                  <ErrorState error={unassignSelected.error} />
                )}

              <ul className="divide-y rounded-md border">
                {items.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    select={
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        /*
                         * ⚠️ Each checkbox needs its own accessible name. A
                         * column of controls all called "Select" is ambiguous
                         * to a screen reader and to any by-name locator.
                         */
                        aria-label={`Select ${product.name}`}
                        checked={selected.has(product.externalId)}
                        onChange={() => toggle(product.externalId)}
                      />
                    }
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={assigned.has(`product:${product.externalId}`) || assign.isPending}
                        /* WooCommerce's id — never `product.id`. */
                        onClick={() => assign.mutate(product.externalId)}
                      >
                        {assigned.has(`product:${product.externalId}`) ? 'Assigned' : 'Assign'}
                      </Button>
                    }
                  />
                ))}
              </ul>
              </>
            )}
          </AsyncState>

          {catalogue.data?.hasMore ? (
            <p className="text-muted-foreground text-xs">
              More products match than are shown. Narrow the search to find a specific one.
            </p>
          ) : null}

          {assign.error === null ? null : <ErrorState error={assign.error} />}

          {/*
           * Assigning by category, tag, attribute or price band (M19.1').
           *
           * 🔴 **A typed reference, not a chooser, and that is a known
           * trade-off.** Nothing lists a store's categories: `store_products`
           * holds them as JSON for sync bookkeeping and no endpoint exposes
           * them, so a chooser would be empty on every real store until M19.1's
           * catalogue import lands. A merchant who mistypes a slug gets an
           * assignment that never resolves — surfaced today by the plugin's
           * skipped-assignment counter in **Optionia → System Status**, and
           * replaced by a real chooser once the import can name them.
           */}
          <form
            className="space-y-2 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();

              const ref = targetRef.trim();

              /* Empty is refused here so the request is never made at all. */
              if (ref !== '') {
                assignTarget.mutate({ targetType, targetRef: ref });
              }
            }}
          >
            <label className="block text-sm font-medium" htmlFor="assignment-target-type">
              Or assign by category, tag, attribute or price range
            </label>

            <div className="flex gap-2">
              <select
                id="assignment-target-type"
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
                value={targetType}
                onChange={(event) => setTargetType(event.target.value as AssignmentTargetType)}
              >
                {ASSIGNMENT_TARGET_TYPES.filter((type) => type !== 'product').map((type) => (
                  <option key={type} value={type}>
                    {TARGET_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>

              <Input
                value={targetRef}
                placeholder={
                  targetType === 'price_range' ? 'e.g. 10-20' : 'e.g. summer-sale'
                }
                /*
                 * ⚠️ Distinct from the `<label>` above, which names the select.
                 * One accessible name matching two controls makes every
                 * by-label lookup ambiguous — Playwright fails such a locator
                 * rather than guessing, and a screen reader announces two
                 * fields as the same thing.
                 */
                aria-label="Reference to assign"
                onChange={(event) => setTargetRef(event.target.value)}
              />

              {/*
                * ⚠️ **Not plain "Assign".** The catalogue rows above use that
                * exact label, and the canonical E2E selects the catalogue's by
                * accessible name. Two buttons sharing one name would leave that
                * selector resolving by render order — working today by accident
                * and breaking the moment the layout moves.
                */}
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={targetRef.trim() === '' || assignTarget.isPending}
              >
                Assign target
              </Button>
            </div>

            {/*
              * The count, before applying (M19.5).
              *
              * 🔴 **"about", and only for a taxonomy.** The mirror is a
              * snapshot and the storefront resolves `has_term()` live, so a
              * product categorised after this reads still matches. `exact`
              * says which kind of number this is; presenting an estimate as a
              * fact is what this wording prevents.
              *
              * ⚠️ **`matched === null` means uncountable, not zero** —
              * `attribute` and `price_range` have no defined reference format,
              * so there is nothing to count and nothing is claimed.
              */}
            {targetCount.data === undefined || targetCount.data.matched === null ? null : (
              <p className="text-muted-foreground text-xs" aria-live="polite">
                {targetCount.data.exact
                  ? `Applies to ${targetCount.data.matched} product${targetCount.data.matched === 1 ? '' : 's'}.`
                  : `Applies to about ${targetCount.data.matched} product${targetCount.data.matched === 1 ? '' : 's'} in your catalogue today.`}
              </p>
            )}

            <p className="text-muted-foreground text-xs">
              Type the slug exactly as it appears in WooCommerce. Category and tag assignments
              apply on your storefront; attribute and price range are saved but not yet resolved.
            </p>

            {assignTarget.error === null ? null : <ErrorState error={assignTarget.error} />}
          </form>
        </div>
      ) : null}
    </section>
  );
}
