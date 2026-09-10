import { AppShell } from '@/components/layout/app-shell';
import { RequireMerchant } from '@/components/layout/route-guards';

/** The merchant dashboard: verified, with a workspace. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireMerchant>
      <AppShell>{children}</AppShell>
    </RequireMerchant>
  );
}
