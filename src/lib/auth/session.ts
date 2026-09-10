import { api } from '../api/client';
import { clearSession, setSession } from './token-store';

/** Who the caller is, as `GET /auth/me` reports it. */
export interface Me {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  locale: string | null;
  tenant: { id: string; name: string; slug: string; status: string } | null;
  role: string | null;
}

interface LoginResponse {
  userId: string;
  emailVerified: boolean;
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  role: string;
}

/** Sign in, and keep the tokens. */
export async function signIn(email: string, password: string): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>('/auth/login', { email, password });

  setSession(data);

  return data;
}

/**
 * Sign out, locally whatever the API says.
 *
 * The request is best-effort: a merchant who clicks "sign out" on a flaky
 * connection must still end up signed out **here**, or the button appears
 * broken and they leave the session live on a shared machine. The refresh
 * family is revoked when the call succeeds; when it does not, the token is gone
 * from this browser and expires on its own.
 */
export async function signOut(refreshToken: string | null): Promise<void> {
  try {
    if (refreshToken !== null) {
      await api.post('/auth/logout', { refreshToken });
    }
  } catch {
    // Deliberately ignored. See above.
  } finally {
    clearSession();
  }
}

/**
 * Who the caller is.
 *
 * Also the boot-time "is this session still good" probe: a client that starts by
 * asking who it is learns immediately whether to refresh, which is one fewer
 * special case than discovering it on the first real request.
 */
export async function fetchMe(): Promise<Me> {
  const { data } = await api.get<Me>('/auth/me');

  return data;
}
