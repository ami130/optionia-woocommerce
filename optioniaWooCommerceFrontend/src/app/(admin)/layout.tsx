import { RequirePlatformStaff } from '@/components/layout/route-guards';

/**
 * Platform staff (Phase 26).
 *
 * Nothing is behind this yet. It exists so the group is closed from the day it
 * exists rather than opened by default and secured later.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <RequirePlatformStaff>{children}</RequirePlatformStaff>;
}
