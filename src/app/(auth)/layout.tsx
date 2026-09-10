import { Suspense } from 'react';

import { RequireAnonymous } from '@/components/layout/route-guards';

/** Sign-in, register and reset. A signed-in visitor is sent to the dashboard. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `RequireAnonymous` reads `?next=` so a signed-in merchant arriving mid
     * handshake is returned to it rather than dropped at the dashboard. That
     * makes it a `useSearchParams` consumer, which Next requires a Suspense
     * boundary around — without one the whole group opts out of static
     * rendering and the build says so.
     */
    <Suspense fallback={null}>
      <RequireAnonymous>
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </RequireAnonymous>
    </Suspense>
  );
}
