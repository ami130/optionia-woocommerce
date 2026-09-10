'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api/error';

/**
 * TanStack Query, configured for this API's failure modes.
 *
 * The client is created **inside** the component rather than at module scope:
 * a module-level client is shared across every request on the server, so one
 * user's cached data can be served to another. `useState` gives each browser
 * session its own.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /**
             * **Never retry a 4xx.** A 401 has already been through the client's
             * refresh-and-retry, a 403 will be refused again, and a 400 is the
             * same request. Retrying those turns one clear failure into four
             * slow ones and burns rate limit doing it.
             */
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status < 500) {
                return false;
              }

              return failureCount < 2;
            },
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            // A mutation is a merchant's deliberate act. Repeating it silently
            // risks doing it twice.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
