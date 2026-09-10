'use client';

import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApiError } from '@/lib/api/error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formLevelMessage } from '@/lib/forms/api-errors';

/**
 * The four states, once.
 *
 * M13.1 requires every screen to ship loading, empty, error and populated. As a
 * rule each screen re-implements, that lasts until the first busy afternoon.
 * As components, the rule is the default and skipping one is a visible omission.
 *
 * **An empty state that says "No data" is a defect.** A merchant's first visit to
 * every screen is the empty state, which makes it the highest-leverage
 * onboarding surface in the product — so `EmptyState` requires an action and a
 * sentence rather than accepting a bare message.
 */

/** Loading. A skeleton in the shape of the content, never a spinner. */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (unused, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

/** Loading, before anything at all is known — a guard deciding where to send you. */
export function FullPageLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <div className="w-full max-w-sm space-y-4 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

/**
 * Empty — with the action that fills it.
 *
 * `action` is required, not optional. A screen with genuinely nothing to do
 * about its emptiness is rare enough to be worth arguing for at the call site.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">{description}</p>
      <div className="mt-6">{action}</div>
    </div>
  );
}

/**
 * Error — with a retry.
 *
 * The message comes from `formLevelMessage`, so a 403 reads as a permissions
 * problem and an unreachable API reads as a connection one. A single "Something
 * went wrong" for both sends a merchant to support over their own wifi.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>That did not work</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{formLevelMessage(error) ?? 'Something went wrong.'}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * A `409` from optimistic locking, named rather than generalised.
 *
 * 🔴 **Shared because two screens need it and only one had it.** The editor
 * explained a conflict on publish while the list showed "something went wrong"
 * for a stale delete — the same failure, described two ways, because the
 * component was private to one file.
 *
 * The distinction is worth making: every other error means *try something
 * different*, and this one means *look at what changed first*. Nothing has been
 * overwritten, and saying so is the difference between a merchant reloading and
 * a merchant re-typing.
 */
export function ConflictAwareError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 409) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Someone else changed this</AlertTitle>
        <AlertDescription>
          Reload to see their changes first. Nothing has been overwritten.
        </AlertDescription>
      </Alert>
    );
  }

  return <ErrorState error={error} onRetry={onRetry} />;
}

/**
 * All four, chosen for you.
 *
 * A screen renders `<AsyncState>` around its content and cannot forget a case —
 * the omission becomes a type error rather than a blank panel.
 */
export function AsyncState<T>({
  isLoading,
  isRefreshing = false,
  error,
  data,
  onRetry,
  empty,
  children,
}: {
  isLoading: boolean;
  /**
   * A *further* fetch is in flight while earlier results are still on screen.
   *
   * 🔴 **Without this, a filtered list silently lies.** TanStack's `isLoading`
   * is true only for the very first fetch of a key; every later one — a new
   * search term, a changed store — leaves `isLoading` false and the previous
   * rows rendered. The list then shows results for a term the merchant has
   * already replaced, with nothing to say so, and looks like a search box that
   * ignores input.
   *
   * Debouncing widened that window rather than causing it: the stale rows now
   * stand for the pause *plus* the round trip. Pass `isFetching` here.
   */
  isRefreshing?: boolean;
  error: unknown;
  data: T[] | undefined;
  onRetry?: () => void;
  empty: ReactNode;
  children: (rows: T[]) => ReactNode;
}) {
  if (isLoading) {
    return <LoadingRows />;
  }

  if (error !== null && error !== undefined) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (data === undefined || data.length === 0) {
    /*
     * An empty *stale* result is still stale. Showing "nothing has been
     * imported yet" mid-search would answer a question the merchant did not
     * ask, so the skeleton stands in until the real answer arrives.
     */
    return isRefreshing ? <LoadingRows /> : <>{empty}</>;
  }

  /*
   * Dimmed and inert rather than replaced: swapping settled rows for a skeleton
   * on every keystroke makes the page flash, and these rows are still the last
   * true answer. `aria-busy` says the same thing to a screen reader, which
   * cannot see the opacity.
   */
  return (
    <div
      aria-busy={isRefreshing}
      className={isRefreshing ? 'pointer-events-none opacity-60 transition-opacity' : undefined}
    >
      {children(data)}
    </div>
  );
}
