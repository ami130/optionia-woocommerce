'use client';

import { useSession } from '@/components/providers/session-provider';

/**
 * The dashboard, as a placeholder.
 *
 * Stage 1 delivers the shell, the guards and the data layer; the activation
 * checklist and health are Stage 2's onward. This exists so `(app)` has a
 * destination and the guard chain is exercised by the build.
 */
export default function DashboardPage() {
  const { me } = useSession();

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-muted-foreground text-sm">
        Signed in as {me?.name} ({me?.role}) in {me?.tenant?.name}.
      </p>
    </div>
  );
}
