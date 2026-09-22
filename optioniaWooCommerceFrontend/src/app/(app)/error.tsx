'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

/**
 * A render error **inside** the dashboard, caught without losing the dashboard.
 *
 * ## Why a second boundary
 *
 * `app/error.tsx` catches everything, which is what makes it the safety net —
 * but it replaces the *whole page*, `AppShell` and its navigation included. A
 * merchant whose Products screen threw would lose the sidebar and every route
 * out of it, and a broken screen would be indistinguishable from a broken
 * product.
 *
 * Next renders a segment's `error.tsx` **inside** that segment's layout, so this
 * one keeps the shell: the failure is scoped to the panel that failed, and every
 * other screen stays one click away. The root boundary still stands behind it
 * for anything thrown by the layout or the guards themselves.
 *
 * No `min-h-screen` here, deliberately — this renders into the shell's content
 * area, not the viewport.
 */
export default function AppSectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /* Next replaces a production message with a digest; a boundary that logs
     * nothing destroys the only record of what actually broke. */
    console.error('Unhandled render error in the dashboard:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed p-8">
      <div className="space-y-2">
        <h2 className="text-lg font-medium">This screen could not be shown</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          Something went wrong rendering this page. The rest of your dashboard is unaffected —
          use the navigation to carry on, or try again.
        </p>

        {error.digest === undefined ? null : (
          <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
        )}
      </div>

      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
