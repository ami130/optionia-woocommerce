'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { safeNextPath } from '@/lib/auth/next-path';
import { FullPageLoading } from './states';

/**
 * The three guards, one per route group.
 *
 * **Client-side, and that is a routing decision rather than a security one.**
 * Nothing here protects data: every response is authorised by the API against
 * the token, so a merchant who edits their way past a guard sees an empty screen
 * and a string of 403s. These exist so the *right* screen appears — a signed-out
 * user at `/login` rather than at a dashboard that fails to load.
 *
 * Stated because the opposite assumption is a real one to make: a guard that
 * looks like protection invites putting something behind it that the API does
 * not also refuse.
 */

/** `(auth)` — sign-in, register, reset. Signed-in users belong elsewhere. */
export function RequireAnonymous({ children }: { children: ReactNode }) {
  const { me, isLoading } = useSession();
  const router = useRouter();
  const params = useSearchParams();

  /**
   * ⚠️ **The guard honours `?next=` too, and that is not redundant.**
   *
   * It runs **before** the sign-in form reads the parameter, so an
   * already-signed-in merchant arriving at `/login?next=/connect?...` would be
   * sent to `/dashboard` and the handshake silently abandoned — the exact
   * failure `?next=` was added to prevent, reintroduced one layer up.
   *
   * `safeNextPath` refuses anything but a same-origin path, so this cannot
   * become an open redirect either.
   */
  const next = safeNextPath(params.get('next'));

  useEffect(() => {
    if (!isLoading && me !== null) {
      router.replace(next);
    }
  }, [isLoading, me, next, router]);

  if (isLoading) {
    return <FullPageLoading />;
  }

  /*
   * Render nothing while the redirect runs. Showing the sign-in form to someone
   * already signed in, even for a frame, invites a second sign-in that discards
   * a perfectly good session.
   */
  return me === null ? <>{children}</> : <FullPageLoading />;
}

/**
 * `(app)` — the merchant dashboard.
 *
 * Three states, not two. An **unverified** user is signed in and must not be
 * sent to `/login`, where signing in again changes nothing: they are routed to
 * the verification prompt instead.
 */
export function RequireMerchant({ children }: { children: ReactNode }) {
  const { me, isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (me === null) {
      router.replace('/login');
    } else if (!me.emailVerified) {
      router.replace('/verify-email');
    } else if (me.tenant === null) {
      /*
       * Signed in, verified, and a member of nothing -- every membership
       * revoked. There is no screen they can use, and sending them to `/login`
       * would loop, so this is its own destination.
       */
      router.replace('/no-workspace');
    }
  }, [isLoading, me, router]);

  if (isLoading) {
    return <FullPageLoading />;
  }

  return me !== null && me.emailVerified && me.tenant !== null ? (
    <>{children}</>
  ) : (
    <FullPageLoading />
  );
}

/**
 * `(session)` — signed in, and nothing more required.
 *
 * For screens a signed-in user must reach **regardless** of verification or
 * membership: `/no-workspace` is the one today. It cannot live in `(app)`,
 * because `RequireMerchant` redirects tenantless users *to* it — a screen behind
 * the guard that sends people there redirects to itself forever.
 *
 * Found by the exhaustive guard test, not by reading: it needs three conditions
 * at once — signed in, verified, member of nothing — which is a state easy to
 * miss and trivially reachable when an owner revokes the last membership.
 */
export function RequireSignedIn({ children }: { children: ReactNode }) {
  const { me, isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && me === null) {
      router.replace('/login');
    }
  }, [isLoading, me, router]);

  if (isLoading) {
    return <FullPageLoading />;
  }

  return me === null ? <FullPageLoading /> : <>{children}</>;
}

/**
 * `(verify)` — signed in, not yet verified.
 *
 * 🔴 **This group exists because of a redirect loop.** `/verify-email` began in
 * `(auth)`, whose guard sends any signed-in visitor to the dashboard — but an
 * unverified user is signed in, and is exactly who that screen is for:
 *
 * ```text
 * /dashboard     → RequireMerchant:  signed in, unverified → /verify-email
 * /verify-email  → RequireAnonymous: signed in             → /dashboard
 * ```
 *
 * Every newly registered merchant landed in it. `(auth)` means "no session";
 * this means "session, not yet usable", and the two are not the same state.
 *
 * A **verified** user here is also redirected: someone who follows an old
 * verification link after verifying should reach their dashboard, not a screen
 * telling them to do what they have already done.
 */
export function RequireUnverified({ children }: { children: ReactNode }) {
  const { me, isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (me === null) {
      /*
       * No session at all. That is legitimate here -- a verification link opened
       * in a browser that has never signed in -- and the screen still works,
       * because the token in the URL is what verifies, not the session. The page
       * decides; the guard only keeps a *verified* user out.
       */
      return;
    }

    if (me.emailVerified) {
      router.replace('/dashboard');
    }
  }, [isLoading, me, router]);

  if (isLoading) {
    return <FullPageLoading />;
  }

  return me?.emailVerified === true ? <FullPageLoading /> : <>{children}</>;
}

/**
 * `(admin)` — platform staff.
 *
 * **Nothing is behind this yet**: staff routes arrive in Phase 26. It ships now
 * so the group is closed by default from the day it exists — retrofitting a
 * guard onto routes that already work is how one gets forgotten.
 *
 * A merchant token must never pass. `role` here is a *tenant* role, and platform
 * staff are a separate vocabulary (`StaffCapability`) the merchant token cannot
 * carry — so until Phase 26 issues a staff token, this correctly admits nobody.
 */
export function RequirePlatformStaff({ children }: { children: ReactNode }) {
  const { isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading) {
      router.replace('/dashboard');
    }
  }, [isLoading, router]);

  if (isLoading) {
    return <FullPageLoading />;
  }

  // Deliberately unreachable until Phase 26. `children` is referenced so the
  // signature stays honest and the group renders once staff tokens exist.
  return process.env.NEXT_PUBLIC_ENABLE_ADMIN === 'true' ? <>{children}</> : <FullPageLoading />;
}
