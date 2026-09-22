import { RequireUnverified } from '@/components/layout/route-guards';

/**
 * Its own route group, and the reason is a redirect loop.
 *
 * 🔴 `/verify-email` began in `(auth)`, whose guard sends **any** signed-in
 * visitor to the dashboard. But an unverified user *is* signed in — and they are
 * the one person this screen exists for:
 *
 * ```text
 * /dashboard     → RequireMerchant:  signed in, unverified → /verify-email
 * /verify-email  → RequireAnonymous: signed in             → /dashboard
 *                                                            forever
 * ```
 *
 * Every newly registered merchant landed there. `(auth)` means "no session";
 * verification is "session, not yet usable", which is a third state and needs a
 * third group.
 */
export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireUnverified>
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </RequireUnverified>
  );
}
