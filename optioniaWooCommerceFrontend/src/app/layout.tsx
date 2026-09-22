import type { Metadata } from 'next';
import './globals.css';

import { QueryProvider } from '@/components/providers/query-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: 'Optionia',
  description: 'Advanced product options for WooCommerce.',
};

/**
 * The root layout.
 *
 * `QueryProvider` wraps `SessionProvider` because the session **is** a query:
 * it is fetched, cached and invalidated like any other, and inverting the order
 * would leave `useQuery` without a client.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <QueryProvider>
          <SessionProvider>{children}</SessionProvider>
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
