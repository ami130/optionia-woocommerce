'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth/session';
import { getRefreshToken } from '@/lib/auth/token-store';
import { cn } from '@/lib/utils';

/**
 * The navigation, including what is not built yet.
 *
 * M13.7: unbuilt items are **disabled rather than hidden**. A merchant who can
 * see that Analytics is coming does not write in asking whether Optionia has
 * analytics — and the shape of the product is legible from the first screen.
 */
const NAVIGATION: ReadonlyArray<{ href: string; label: string; phase?: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/option-sets', label: 'Option sets' },
  { href: '/products', label: 'Products' },
  { href: '/stores', label: 'Stores' },
  { href: '/rules', label: 'Rules', phase: 'Phase 17' },
  { href: '/analytics', label: 'Analytics', phase: 'Phase 25' },
  { href: '/subscription', label: 'Subscription', phase: 'Phase 22' },
  /*
   * 🔴 A live link to a page that does not exist. Profile, team and
   * notification settings are later phases, so Settings takes a marker like
   * Rules and Analytics — the mechanism was already here, this item just
   * never used it, and the difference is Next's not-found page.
   */
  { href: '/settings', label: 'Settings', phase: 'a later phase' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="font-semibold">
            Optionia
          </Link>
          {me?.tenant ? (
            <span className="text-muted-foreground hidden text-sm sm:inline">
              {me.tenant.name}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted-foreground hidden text-sm sm:inline">{me?.email}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await signOut(getRefreshToken());
              router.replace('/login');
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col sm:flex-row">
        {/*
          Horizontally scrollable on a phone, a sidebar from `sm` up. Merchants
          check stores on phones, so the navigation has to work there — it is not
          a desktop layout that happens to shrink.
        */}
        <nav className="flex gap-1 overflow-x-auto border-b p-2 sm:w-56 sm:flex-col sm:border-b-0 sm:border-r sm:p-4">
          {NAVIGATION.map((item) =>
            item.phase === undefined ? (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors',
                  pathname.startsWith(item.href)
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'hover:bg-accent/50',
                )}
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.href}
                aria-disabled="true"
                title={`Arriving in ${item.phase}`}
                className="text-muted-foreground/60 cursor-not-allowed rounded-md px-3 py-2 text-sm whitespace-nowrap"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
