import { AppShell } from '@/components/layout/app-shell';
import { RequirePlatformStaff } from '@/components/layout/route-guards';

/**
 * Platform staff (M26.5).
 *
 * 🔴 **Inside `AppShell`, like the merchant group.** The first version of this
 * layout wrapped the guard alone, so the one page behind it rendered with no
 * navigation and no way back — a staff member who reached it had the browser's
 * back button or a retyped URL. The shell is what makes it a screen rather than
 * a destination.
 *
 * ⚠️ **The shell shows the Platform section only to staff**, so a merchant never
 * sees a link to a room they cannot enter. That is rendering; `StaffGuard`
 * refuses every `/admin` request server-side regardless.
 *
 * ✏️ This docblock read "Nothing is behind this yet" until M26.5 put a page
 * here. It was true when the group was created and quietly stopped being so.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequirePlatformStaff>
      <AppShell>{children}</AppShell>
    </RequirePlatformStaff>
  );
}
