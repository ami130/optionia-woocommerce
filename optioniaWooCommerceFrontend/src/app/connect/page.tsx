'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { ErrorState, FullPageLoading } from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { roleCan } from '@/lib/auth/capabilities';
import { loginUrlReturningTo } from '@/lib/auth/next-path';
import { authorizeConnection, describeRequest } from '@/lib/stores/api';
import { cn } from '@/lib/utils';

/**
 * The handshake's approval screen (M13.3, Phase 8).
 *
 * WordPress sends the merchant here as `/connect?request=…&state=…`, and this
 * screen is the **consent step**: it names the site asking to connect, takes the
 * approval, and hands back a redirect that returns to WordPress where the plugin
 * completes the exchange.
 *
 * ## No route group, deliberately
 *
 * `(auth)` would bounce a signed-in merchant away; `(app)` would bounce a
 * signed-out one to a dashboard that discards `request` and `state`. Neither is
 * right, because this screen serves both — so it guards itself, sending a
 * signed-out visitor to `/login?next=` the **whole current URL** and back again.
 *
 * The request lives 30 minutes, so a sign-in detour is comfortably survivable —
 * but only if the parameters survive it.
 */
function ConnectContent() {
  const params = useSearchParams();
  const router = useRouter();
  const { me, isLoading } = useSession();

  const request = params.get('request');
  const state = params.get('state');

  /**
   * Send a signed-out merchant to sign in, and bring them back **here**.
   *
   * Without the `next`, the handshake would have to be restarted from
   * WordPress, and nothing on screen would say why — which is the "assumes it
   * failed and starts again" behaviour the 60-second criterion exists to
   * prevent.
   */
  useEffect(() => {
    if (!isLoading && me === null && request !== null && state !== null) {
      router.replace(
        loginUrlReturningTo(`/connect?request=${encodeURIComponent(request)}&state=${encodeURIComponent(state)}`),
      );
    }
  }, [isLoading, me, request, state, router]);

  const query = useQuery({
    queryKey: ['connect', 'request', request],
    queryFn: () => describeRequest(request as string, state as string),
    enabled: me !== null && request !== null && state !== null,
    retry: false,
  });

  const approve = useMutation({
    mutationFn: () => authorizeConnection(request as string, state as string),
    onSuccess: (result) => {
      /*
       * A full-page navigation, not `router.push`: the destination is the
       * merchant's **own WordPress site**, which this app does not route.
       */
      window.location.href = result.redirect_url;
    },
  });

  if (request === null || state === null) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>That link is incomplete</AlertTitle>
          <AlertDescription>
            Start the connection again from the Optionia screen in your WordPress admin.
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }

  if (isLoading || me === null) {
    return <FullPageLoading />;
  }

  if (query.isLoading) {
    return <FullPageLoading />;
  }

  /*
   * 🔴 **`data === undefined` belongs here, not just `error`.**
   *
   * This screen asks a merchant to authorise a named site, and the name is the
   * whole consent. Checking only `error` left one path — settled, not loading,
   * no error, no data — that rendered "Connect this store?" above an **empty
   * site URL**, which is a consent dialog that does not say what is being
   * consented to. The option-set editor already guards both; this one did not.
   *
   * The two cases share an answer deliberately: a request that produced neither
   * data nor an error is as unusable as an expired one, and the remedy — start
   * again from WordPress — is the same.
   */
  if (query.error !== null || query.data === undefined) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>This connection request is no longer valid</AlertTitle>
          <AlertDescription>
            Links expire after 30 minutes, and each can be used once. Start again from the
            Optionia screen in your WordPress admin.
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }

  /** Past every guard, so the site is known and can be named without a fallback. */
  const connection = query.data;

  /**
   * Whether this member may approve at all.
   *
   * 🔴 `stores:connect` belongs to `owner` and `admin` only. Without this check
   * an editor walked the entire approval flow — saw the site, read the consent
   * copy, pressed **Connect store** — and failed at the last step. The request
   * survives that `403` (the guard rejects before the service runs, so
   * `approvedAt` is untouched), so the remedy is real: an owner can finish the
   * same link. Saying so is the difference between a dead end and a next step.
   */
  const canApprove = roleCan(me.role, 'stores:connect');

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Connect this store?</CardTitle>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="space-y-3 text-sm">
            {/*
              The site is named, and that is the whole point of this screen: a
              merchant handed a link must be able to see what they are approving.
            */}
            <Row label="Site" value={connection.site_url} />
            <Row label="Plugin" value={connection.plugin_version ?? 'Unknown version'} />
            <Row label="Workspace" value={me.tenant?.name ?? ''} />
          </div>

          <p className="text-muted-foreground text-sm">
            Connecting lets Optionia serve product options on this store and read its catalogue.
            You can disconnect at any time.
          </p>

          {approve.error === null || approve.error === undefined ? null : (
            <ErrorState error={approve.error} />
          )}

          {canApprove ? null : (
            <Alert>
              <AlertTitle>You cannot approve this connection</AlertTitle>
              <AlertDescription>
                Connecting a store needs an owner or admin. Send this link to one of them — it
                stays valid for 30 minutes from when it was created.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="flex-1"
              disabled={approve.isPending || !canApprove}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? 'Connecting…' : 'Connect store'}
            </Button>

            {/*
              A styled link rather than a button wrapping one: this `Button` has
              no `asChild`, and nesting an anchor inside a button is invalid
              markup that keyboards and screen readers both handle badly.
            */}
            <Link
              href="/stores"
              className={cn(buttonVariants({ variant: 'outline' }), 'flex-1')}
            >
              Cancel
            </Link>
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium break-all">{value}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<FullPageLoading />}>
      <ConnectContent />
    </Suspense>
  );
}
