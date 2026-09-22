'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

import { ApiError } from '@/lib/api/error';
import { fetchMe, type Me } from '@/lib/auth/session';
import { getRefreshToken, onSignOut } from '@/lib/auth/token-store';

interface SessionState {
  me: Me | null;
  isLoading: boolean;
  /** Re-read the profile — after a name change, or a role change. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * The signed-in user, resolved once and shared.
 *
 * ## Why this asks the API rather than reading the token
 *
 * The access token carries `sub`, `tid` and `role` — enough to route, and
 * nothing a header can display. `GET /auth/me` is the only source of a name, an
 * email, or the tenant's name, and reading it live means a role changed
 * elsewhere shows up here rather than persisting until the next sign-in.
 *
 * ## Why it runs even with no token in memory
 *
 * On a reload the access token is gone by design — only the refresh token
 * survives. The first `me` call therefore 401s, the API client refreshes, and
 * the retry succeeds. That is the intended boot sequence, not an error path.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['session', 'me'],
    queryFn: fetchMe,
    /*
     * With no refresh token there is nothing to recover from, so asking would be
     * a guaranteed 401 on every page load of the sign-in screen.
     */
    enabled: typeof window !== 'undefined' && getRefreshToken() !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });

  /**
   * The API client clears the session from outside React — it is not a
   * component and cannot route. This is the bridge: when that happens, drop the
   * cache and send the user to sign in.
   */
  useEffect(
    () =>
      onSignOut(() => {
        queryClient.clear();
        router.replace('/login');
      }),
    [queryClient, router],
  );

  const value: SessionState = {
    me: query.data ?? null,
    // A 401 is not "still loading": it is a resolved answer of "nobody".
    isLoading: query.isLoading && !isApiError(query.error),
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session', 'me'] });
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Narrowing helper: `query.error` is `unknown` until proven otherwise. */
function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession must be used inside <SessionProvider>.');
  }

  return context;
}
