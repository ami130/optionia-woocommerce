'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  BarChart3,
  CreditCard,
  LayoutDashboard,
  Package,
  Settings,
  SlidersHorizontal,
  Store,
  Workflow,
} from 'lucide-react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
const NAVIGATION: ReadonlyArray<{ href: string; label: string; phase?: string; icon: typeof LayoutDashboard }> = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/option-sets', label: 'Option sets', icon: SlidersHorizontal },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/stores', label: 'Stores', icon: Store },
  { href: '/rules', label: 'Rules', phase: 'Phase 17', icon: Workflow },
  { href: '/analytics', label: 'Analytics', phase: 'Phase 25', icon: BarChart3 },
  { href: '/subscription', label: 'Subscription', phase: 'Phase 22', icon: CreditCard },
  /*
   * 🔴 A live link to a page that does not exist. Profile, team and
   * notification settings are later phases, so Settings takes a marker like
   * Rules and Analytics — the mechanism was already here, this item just
   * never used it, and the difference is Next's not-found page.
   */
  { href: '/settings', label: 'Settings', phase: 'a later phase', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
        {/*
          ⚠️ **The tenant name is divided from the product name, not merely
          spaced from it.** A merchant with access to more than one tenant
          reads this line to know which they are editing, and two runs of text
          a gap apart do not say which is the product and which is the account.
          `truncate` because a tenant name is merchant-supplied and unbounded.
        */}
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/dashboard"
            className="hover:text-primary shrink-0 font-semibold transition-colors"
          >
            Optionia
          </Link>
          {me?.tenant ? (
            <>
              <Separator orientation="vertical" className="hidden h-5 sm:block" />
              <span className="text-muted-foreground hidden truncate text-sm sm:inline">
                {me.tenant.name}
              </span>
            </>
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
              /*
               * 🔴 **The active item carries a left bar, not only a tint.** At
               * this width a tinted row and an untinted one are a shade apart;
               * a 2px rule is the signal a merchant already reads in every
               * admin they use, WordPress's own included. `aria-current` says
               * the same thing to a screen reader, which the tint never did.
               */
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-2.5 border-l-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
                  pathname.startsWith(item.href)
                    ? 'border-l-primary bg-accent text-accent-foreground rounded-r-md font-medium'
                    : 'hover:bg-accent/50 rounded-md border-l-transparent',
                )}
              >
                <item.icon
                  className={cn(
                    'size-4 shrink-0 transition-colors',
                    pathname.startsWith(item.href)
                      ? 'text-primary'
                      : 'text-muted-foreground group-hover:text-foreground',
                  )}
                  aria-hidden="true"
                />
                {item.label}
              </Link>
            ) : (
              /*
               * ⚠️ **A tooltip, where this was a `title` attribute.** M13.7
               * keeps unbuilt items visible so the product's shape is legible
               * from the first screen — and `title` shows only on hover, after
               * a delay, never on touch. The reason an item is unavailable
               * should not be the hardest thing on the page to find.
               */
              <Tooltip key={item.href}>
                <TooltipTrigger
                  aria-disabled="true"
                  className="text-muted-foreground/50 flex cursor-not-allowed items-center gap-2.5 border-l-2 border-l-transparent px-3 py-2 text-sm whitespace-nowrap"
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                </TooltipTrigger>
                <TooltipContent side="right">Arriving in {item.phase}</TooltipContent>
              </Tooltip>
            ),
          )}
        </nav>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
      </div>
    </TooltipProvider>
  );
}
