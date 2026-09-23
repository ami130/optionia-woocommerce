import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, apiRequest } from './client';
import { ApiError, NetworkError } from './error';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  setRefreshClaimedAt,
  setSession,
} from '../auth/token-store';

const BASE = 'http://localhost:4000/v1';

/** A successful envelope, as the API sends it. */
const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ data, meta: { requestId: 'r-1' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** An error body, as the exception filter sends it. */
const fail = (status: number, code: string, details?: unknown): Response =>
  new Response(
    JSON.stringify({ error: { code, message: 'nope', details }, meta: { requestId: 'r-2' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

describe('api client', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- The envelope --------------------------------------------------------

  it('unwraps the data envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ id: 'a' }));

    const result = await api.get<{ id: string }>('/stores');

    expect(result.data).toEqual({ id: 'a' });
    expect(result.meta.requestId).toBe('r-1');
  });

  it('returns undefined data for a 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const result = await api.delete('/option-sets/x/assignments/wc-1');

    expect(result.data).toBeUndefined();
  });

  it('sends the access token when there is one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok([]));
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1' });

    await api.get('/stores');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
  });

  it('sends no Authorization header when signed out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok([]));

    await api.get('/stores');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  /** `undefined` must not become the string "undefined" in a query string. */
  it('drops undefined query parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok([]));

    await api.get('/products', { query: { storeId: 's-1', search: undefined, limit: 25 } });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('storeId=s-1');
    expect(url).toContain('limit=25');
    expect(url).not.toContain('search');
  });

  // --- Errors --------------------------------------------------------------

  it('throws ApiError carrying the code and details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fail(400, 'VALIDATION_FAILED', [{ field: 'groups.0.label', code: 'TOO_LONG' }]),
    );

    const error = await api.post('/option-sets', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
    expect((error as ApiError).isValidation).toBe(true);
    expect((error as ApiError).details[0].field).toBe('groups.0.label');
  });

  /**
   * A dead connection is not a rejected request, and the remedies differ: a
   * retry button belongs on this and not on a 400.
   */
  it('throws NetworkError when the request never completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('failed to fetch'));

    const error = await api.get('/stores').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
  });

  // --- Refresh -------------------------------------------------------------

  /**
   * 🔴 **The behaviour B1 unblocked.**
   *
   * `POST /auth/refresh` returned no access token until Phase 13 Stage 1, so
   * this recovery was impossible: the client refreshed and still held an
   * expired credential.
   */
  it('refreshes once on a 401 and retries the request', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(ok({ accessToken: 'fresh', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(ok([{ id: 'store-1' }]));

    const result = await api.get<Array<{ id: string }>>('/stores');

    expect(result.data).toEqual([{ id: 'store-1' }]);
    expect(getAccessToken()).toBe('fresh');
    expect(getRefreshToken()).toBe('refresh-2');

    // The retry carried the new token, not the expired one.
    const retryHeaders = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh');
  });

  /**
   * 🔴 **Parallel 401s share one refresh.**
   *
   * Refresh tokens rotate and the API revokes the whole family on reuse. Five
   * queries on mount refreshing five times would present an already-replaced
   * token, be read as a replay, and **sign the user out of their own dashboard
   * loading normally**.
   */
  it('refreshes once for several concurrent 401s', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    let refreshCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;

        return ok({ accessToken: 'fresh', refreshToken: 'refresh-2' });
      }

      return getAccessToken() === 'fresh' ? ok([]) : fail(401, 'TOKEN_EXPIRED');
    });

    await Promise.all([api.get('/stores'), api.get('/products'), api.get('/option-sets')]);

    expect(refreshCalls).toBe(1);
  });

  it('gives up after one retry rather than looping', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/auth/refresh')
        ? ok({ accessToken: 'fresh', refreshToken: 'refresh-2' })
        : fail(401, 'TOKEN_EXPIRED'),
    );

    await api.get('/stores').catch(() => undefined);

    // request, refresh, retry — and nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('signs out when the refresh itself fails', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/auth/refresh') ? fail(401, 'TOKEN_INVALID') : fail(401, 'TOKEN_EXPIRED'),
    );

    await api.get('/stores').catch(() => undefined);

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  /**
   * A 200 from refresh that carries no access token is the **old** contract.
   * Treated as a failed refresh rather than trusted, so an outdated API produces
   * a sign-out rather than a loop.
   */
  it('treats a refresh without an access token as a failure', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/auth/refresh')
        ? ok({ refreshToken: 'refresh-2' })
        : fail(401, 'TOKEN_EXPIRED'),
    );

    await api.get('/stores').catch(() => undefined);

    expect(getAccessToken()).toBeNull();
  });

  /**
   * A failed sign-in must stay a failed sign-in.
   *
   * Refreshing after a wrong password would replace a clear message with a
   * confusing sign-out, and would spend the refresh token to do it.
   */
  it('does not refresh on a 401 from a session route', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401, 'UNAUTHENTICATED'));

    await api.post('/auth/login', { email: 'a@b.c', password: 'x' }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('refresh-1');
  });

  /**
   * 🔴 **Every `/auth` route that takes a token is exempt from refresh.**
   *
   * They all answer `401 TOKEN_INVALID` for a bad token, so a signed-in merchant
   * clicking an **expired link** would refresh, spend their rotating token for
   * nothing, and retry a request that can never succeed. Where the session had
   * already ended, it signed them out mid-page.
   *
   * The list was three routes and needed seven; it is now a prefix rule with one
   * named exception, so a route added later is exempt by default.
   */
  it.each([
    '/auth/verify-email',
    '/auth/reset-password',
    '/auth/request-password-reset',
    '/auth/resend-verification',
    '/auth/login',
    '/auth/register',
    /*
     * The handshake routes, added in Stage 3. Both refuse with `TOKEN_INVALID`
     * (401) for an expired or wrong-state request, so a merchant opening a stale
     * approval link would otherwise spend a refresh token on a doomed retry.
     */
    '/connect/authorize',
    '/connect/requests/describe',
  ])('does not refresh on a 401 from %s', async (path) => {
    setSession({ accessToken: 'live', refreshToken: 'refresh-1' });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401, 'TOKEN_INVALID'));

    await api.post(path, {}).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe('refresh-1');
  });

  /**
   * **`/auth/me` is the exception, and the boot sequence depends on it.**
   *
   * On a reload the access token is gone by design; the first `me` call 401s,
   * refreshes, and retries. Exempting it would break sign-in persistence
   * entirely — which is why the rule is an exception list rather than a blanket
   * `/auth/` prefix.
   */
  it('does refresh on a 401 from /auth/me', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(ok({ accessToken: 'fresh', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(ok({ email: 'sam@example.com' }));

    const result = await api.get<{ email: string }>('/auth/me');

    expect(result.data.email).toBe('sam@example.com');
    expect(getAccessToken()).toBe('fresh');
  });

  /**
   * A dropped connection during refresh is not an invalid session.
   *
   * Signing out over a flaky network would log merchants out of a working
   * dashboard, so the session is kept for the next attempt.
   */
  it('keeps the session when the refresh request cannot be sent', async () => {
    setSession({ accessToken: 'expired', refreshToken: 'refresh-1' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/auth/refresh')) {
        throw new TypeError('offline');
      }

      return fail(401, 'TOKEN_EXPIRED');
    });

    await apiRequest('/stores').catch(() => undefined);

    expect(getRefreshToken()).toBe('refresh-1');
  });

  it('does not attempt a refresh with no refresh token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401, 'UNAUTHENTICATED'));

    await api.get('/stores').catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('targets the configured API base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok([]));

    await api.get('/stores');

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/stores`);
  });
});

/**
 * One context must not exchange a token another is already exchanging (F64).
 *
 * 🔴 **Measured in production logs before it was fixed**: `refresh token reuse
 * detected … revoked family`, twice in 95 refreshes, each signing a merchant
 * out of a working dashboard. `refreshInFlight` guards one JS context; a full
 * page navigation empties it while the token in `localStorage` survives, so two
 * contexts each present the same token and the API revokes the family.
 *
 * ⚠️ **The claim is what crosses the boundary**, so these tests write it
 * directly — that is exactly what another context would have left behind.
 */
describe('refresh claim', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    setSession({ accessToken: 'a-1', refreshToken: 'r-old' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  /**
   * 🔴 **The defect.** Another context claimed moments ago and is mid-exchange.
   * This one must NOT send its own `/auth/refresh`.
   */
  it('does not exchange while another context holds a fresh claim', async () => {
    setRefreshClaimedAt(Date.now());

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      /* The other context finishes: its new token lands in storage. */
      if (url.endsWith('/auth/me')) {
        setSession({ accessToken: 'a-2', refreshToken: 'r-new' });

        return fail(401, 'UNAUTHORIZED');
      }

      return ok({ id: 'u-1' });
    });

    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me').catch(() => undefined);

    const refreshCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/auth/refresh'),
    );

    expect(refreshCalls).toHaveLength(0);
  });

  /**
   * 🔴 **The worse failure the TTL exists to prevent.** A context that died
   * mid-refresh leaves its claim behind; without expiry every later context
   * waits forever and the merchant can never sign in again.
   */
  it('exchanges anyway once a stale claim has expired', async () => {
    setRefreshClaimedAt(Date.now() - 60_000);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/auth/refresh')) {
        return ok({ accessToken: 'a-2', refreshToken: 'r-new' });
      }

      return getAccessToken() === 'a-2' ? ok({ id: 'u-1' }) : fail(401, 'UNAUTHORIZED');
    });

    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    const refreshCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/auth/refresh'),
    );

    expect(refreshCalls).toHaveLength(1);
    expect(getRefreshToken()).toBe('r-new');
  });

  /**
   * 🔴 **The claim must be VISIBLE to another context while in flight.**
   * Everything else here writes the claim itself, so none of it noticed when a
   * mutation removed the `setRefreshClaimedAt(Date.now())` that publishes it —
   * the lock check still ran, read `null`, and let every context through. The
   * fix would have been inert and the suite green.
   *
   * ⚠️ **Observed mid-exchange**, because that is the only moment it exists:
   * the `finally` clears it as soon as the request settles.
   */
  it('publishes its claim while the exchange is in flight', async () => {
    let claimDuringExchange: string | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/auth/refresh')) {
        claimDuringExchange = window.localStorage.getItem('optionia.refresh.claimed');

        return ok({ accessToken: 'a-2', refreshToken: 'r-new' });
      }

      return getAccessToken() === 'a-2' ? ok({ id: 'u-1' }) : fail(401, 'UNAUTHORIZED');
    });

    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    expect(claimDuringExchange).not.toBeNull();
    expect(Number(claimDuringExchange)).toBeGreaterThan(0);
  });

  /**
   * 📌 **The claim is released, not left to time out.** A held claim that
   * outlives its exchange makes every other context wait for the full TTL on
   * every refresh — a working session that feels broken.
   */
  it('releases its claim once the exchange finishes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/auth/refresh')) {
        return ok({ accessToken: 'a-2', refreshToken: 'r-new' });
      }

      return getAccessToken() === 'a-2' ? ok({ id: 'u-1' }) : fail(401, 'UNAUTHORIZED');
    });

    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    expect(window.localStorage.getItem('optionia.refresh.claimed')).toBeNull();
  });

  /**
   * ⚠️ **And released when the exchange FAILS**, which is the path a naive
   * fix misses: four `return`s sit between the claim and the end of that
   * function, and a rejected refresh takes one of them.
   */
  it('releases its claim when the exchange is rejected', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? fail(401, 'UNAUTHORIZED')
        : fail(401, 'UNAUTHORIZED'),
    );

    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me').catch(() => undefined);

    expect(window.localStorage.getItem('optionia.refresh.claimed')).toBeNull();
  });
});
