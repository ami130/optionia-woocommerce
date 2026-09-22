'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { invalidateActivation } from '@/lib/activation/cache';
import { api } from '@/lib/api/client';
import { formLevelMessage } from '@/lib/forms/api-errors';
import { cn } from '@/lib/utils';

/**
 * Verify an email address.
 *
 * ⚠️ **Not a form — an action a link performs.** The email built by
 * `AuthService.link()` points at `${APP_URL}/verify-email?token=…`, so the token
 * arrives in the URL and the screen's job is to spend it and report.
 *
 * Two arrivals, both legitimate:
 *
 * - **With a token**, from the email. Verify immediately.
 * - **Without one**, because `RequireMerchant` sent a signed-in but unverified
 *   user here. Offer to resend.
 */
function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();

  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>(
    token === null ? 'idle' : 'working',
  );
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  /**
   * Whether the session must be re-read before this user is treated as verified.
   *
   * Held rather than done immediately, so the success panel survives long enough
   * to read. See the effect below.
   */
  const [needsRefresh, setNeedsRefresh] = useState(false);

  /**
   * Verification tokens are single-use, and React 18 mounts effects twice in
   * development. Without this the second run spends an already-spent token and
   * the screen shows a failure for a verification that worked.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (token === null || attempted.current) {
      return;
    }

    attempted.current = true;

    void (async () => {
      try {
        await api.post('/auth/verify-email', { token });
        setState('done');

        /*
         * The session's `emailVerified` is stale after this, and re-reading it
         * is what lets the guard admit them without a sign-out.
         *
         * ⚠️ Deliberately **not** awaited here for a signed-in user: the moment
         * `me.emailVerified` flips, `RequireUnverified` replaces this screen and
         * redirects, so the "Email verified" panel is swapped out before it can
         * be read. The refresh is deferred so the confirmation is visible, and
         * the guard moves them on when they act — or when the query goes stale
         * on its own.
         */
        setNeedsRefresh(true);
      } catch (caught) {
        setError(formLevelMessage(caught) ?? 'That link is not valid.');
        setState('failed');
      }
    })();
  }, [token]);

  if (state === 'working') {
    return <p className="text-muted-foreground text-sm">Verifying your email…</p>;
  }

  if (state === 'done') {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>Email verified</AlertTitle>
          <AlertDescription>Your account is ready.</AlertDescription>
        </Alert>

        {/*
          A link rather than an automatic redirect: the guard moves a verified
          user onward anyway, and a visitor who arrived without a session needs
          somewhere deliberate to go.

          Styled as a button rather than wrapped in one -- this `Button` has no
          `asChild`, and nesting an anchor inside a button is invalid markup that
          keyboards and screen readers both handle badly.
        */}
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: 'default' }), 'w-full')}
          onClick={() => {
            // Re-read the session on the way out, so `RequireMerchant` sees a
            // verified user and admits them rather than bouncing them back.
            if (needsRefresh) {
              void refresh();
            }

            /*
             * 🔴 **And the funnel, because this is a *client-side* navigation.**
             *
             * `/dashboard` is reached through `<Link>`, so the React Query cache
             * survives and `['activation']` still holds the answer from before
             * verification — for its 30-second `staleTime`, with
             * `refetchOnWindowFocus` off. A merchant who verified and pressed
             * Continue landed on the checklist with "Verify your email" still
             * unticked.
             *
             * `verified` is the **first** step a new merchant completes, so this
             * was the staleness most likely to be seen.
             */
            invalidateActivation(queryClient);
          }}
        >
          Continue
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Verify your email</h1>
        <p className="text-muted-foreground text-sm">
          {state === 'failed'
            ? 'That link did not work. Links expire, and each one can be used only once.'
            : `We sent a link to ${me?.email ?? 'your email address'}. Open it to finish setting up your account.`}
        </p>
      </div>

      {error === null ? null : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {resent ? (
        <Alert>
          <AlertDescription>
            If that address needs verifying, a new link is on its way.
          </AlertDescription>
        </Alert>
      ) : (
        <Button
          variant="outline"
          className="w-full"
          disabled={me?.email === undefined}
          onClick={async () => {
            try {
              await api.post('/auth/resend-verification', { email: me?.email });
            } catch {
              /*
               * Deliberately swallowed. The API answers identically whether or
               * not the address needs verifying, so surfacing a failure here
               * would leak what the endpoint is careful not to say.
               */
            } finally {
              setResent(true);
            }
          }}
        >
          Send a new link
        </Button>
      )}

      <p className="text-muted-foreground text-sm">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary, or the whole route opts out of
 * static rendering and the build says so.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading…</p>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
