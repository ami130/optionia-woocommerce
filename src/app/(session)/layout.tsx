import { RequireSignedIn } from '@/components/layout/route-guards';

/**
 * Signed in, but with nowhere to go in the app.
 *
 * 🔴 **A screen cannot live behind the guard that redirects to it.**
 * `/no-workspace` began inside `(app)`, and `RequireMerchant` sends a tenantless
 * user there — so the screen redirected to itself, forever. The same mistake as
 * `/verify-email` in `(auth)`, found by the exhaustive guard test rather than by
 * reading, because it needs three conditions at once: signed in, verified, and a
 * member of nothing.
 *
 * This group requires only a session, which is the one thing every screen in it
 * has.
 */
export default function SessionLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireSignedIn>
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </RequireSignedIn>
  );
}
