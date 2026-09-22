'use client';

import { useEffect } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';

/**
 * The error boundary M13.1 names and Stage 1 did not build (O3).
 *
 * ## What it catches, and what it does not
 *
 * A **render-time throw** — a component reading a property of something that
 * turned out to be `null`, a `.map` over a value that is not an array. Without
 * this file React unmounts the whole tree and the merchant is left on a blank
 * white page with no message, no retry, and no way back. Every state audited in
 * Stage 6 assumed the render succeeded; this is the state where it did not.
 *
 * It does **not** catch a failed request. Those are values, not exceptions —
 * `AsyncState` and `ErrorState` handle them, and they stay the normal path.
 *
 * ## Why there is no `global-error.tsx`
 *
 * That file catches only what the **root layout itself** throws, and replaces
 * the `<html>` document to do it. This root layout is a pure JSX wrapper —
 * `QueryProvider`, `SessionProvider`, `Toaster`, no data access and no
 * conditional logic — so there is nothing in it that can realistically throw
 * that this boundary would not already catch from its children. Recorded as a
 * decision rather than left as an absence, so the next reader does not have to
 * work out whether it was considered.
 *
 * ## Why `reset()` and a link
 *
 * `reset()` re-renders the segment, which recovers anything transient. When the
 * cause is persistent — bad data on this route — retrying loops, so the link out
 * is the real escape and both are offered.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /*
     * Logged, not swallowed. Next replaces a production error's message with a
     * `digest`, so without this the only record of *what* broke is gone — and a
     * boundary that hides the bug it caught is worse than the white page.
     */
    console.error('Unhandled render error:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Something went wrong on this page</h1>
        <p className="text-muted-foreground max-w-md text-sm">
          The rest of Optionia is still working. Try again, or go back to your dashboard.
        </p>

        {/*
          The digest is the only handle support has on a production stack trace,
          so it is shown rather than logged where a merchant cannot reach it.
        */}
        {error.digest === undefined ? null : (
          <p className="text-muted-foreground font-mono text-xs">Reference: {error.digest}</p>
        )}
      </div>

      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        {/*
          A plain anchor, not `useRouter().push()`. This boundary renders
          *because* something in the tree threw, and a full document load is the
          one navigation that cannot depend on the state that just broke — it
          rebuilds everything from scratch. `<Link>` would prefetch and soft
          navigate, keeping the damaged tree alive.
        */}
        <a href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
