import {
  clearSession,
  getAccessToken,
  getRefreshClaimedAt,
  getRefreshToken,
  setRefreshClaimedAt,
  setSession,
} from '../auth/token-store';
import { refreshIsLocked } from '../auth/refresh-lock';
import { ApiError, NetworkError } from './error';
import type { ApiEnvelope, ApiErrorResponse, ApiMeta } from './types';

/**
 * Where the API lives, including its `/v1` prefix.
 *
 * Exported because one link cannot go through `api.get()`: the plugin download
 * is a **file the browser fetches directly** (M20b.3), so an `<a href>` needs the
 * absolute URL rather than a relative path, which would resolve against the
 * dashboard's own origin.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

const BASE_URL = API_BASE_URL;

/**
 * Routes whose `401` is the answer, not an expired token.
 *
 * 🔴 **This list was three routes and needed seven.** Every `/auth` route that
 * takes a token answers `401 TOKEN_INVALID` for a bad one — `verify-email`,
 * `reset-password`, and the two that take an address — so a signed-in merchant
 * clicking an **expired link** triggered a refresh, spent their rotating token
 * for nothing, and retried a request that could never succeed. Where the session
 * had already ended, it signed them out while they were reading the page.
 *
 * Found by the Stage 2 audit, tracing which codes map to `401` rather than by
 * reading the list.
 *
 * The rule is a prefix on `/auth/`, with the one exception named: `GET /auth/me`
 * **is** an ordinary authenticated request, and a `401` there means exactly what
 * it means everywhere else. Written as an exception list rather than an
 * inclusion list so a route added to `/auth/` later is exempt by default —
 * failing towards "do not spend a refresh token", which is the safe direction.
 */
const REFRESHABLE_AUTH_ROUTES = ['/auth/me'];

/**
 * Prefixes whose `401` means "this credential in the body is wrong", not "your
 * access token expired".
 *
 * 🔴 **`/connect/` was missing, and it is the same defect on a second path.**
 * `authorize` and `describe` refuse with `TOKEN_INVALID`, which maps to `401` —
 * so a merchant opening an **expired handshake** triggered a refresh, spent a
 * rotating token for nothing, and retried a request that could never succeed.
 * Where the session had already ended, it signed them out mid-approval.
 *
 * Found in Phase 13 Stage 3 by tracing which error codes map to `401`, which is
 * the same method that found it on `/auth/` and the reason it was not missed
 * twice.
 */
const CREDENTIAL_IN_BODY_PREFIXES = ['/auth/', '/connect/'];

function isSessionRoute(path: string): boolean {
  if (!CREDENTIAL_IN_BODY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }

  return !REFRESHABLE_AUTH_ROUTES.some((route) => path.startsWith(route));
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Query parameters. `undefined` values are dropped rather than sent as "undefined". */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/** A response, with the envelope's `meta` kept for pagination. */
export interface ApiResult<T> {
  data: T;
  meta: ApiMeta;
}

/**
 * One in-flight refresh, shared by every request that needs it.
 *
 * **Without this, a page that fires five queries on mount refreshes five times.**
 * Refresh tokens rotate and the API detects reuse — so the second rotation would
 * present a token the first had already replaced, the API would treat it as a
 * replay, and **the whole family would be revoked**. The user is signed out by
 * their own dashboard loading normally.
 *
 * That is not a hypothetical: `POST /auth/refresh`'s contract says reuse revokes
 * the family, and a dashboard's first paint is exactly a burst of parallel
 * requests.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * How long a blocked context waits for another to finish rotating.
 *
 * 📌 **Sized against the exchange, not against the lock.** A refresh is one
 * round trip to the API — hundreds of milliseconds on a bad connection. Two
 * seconds covers that with room to spare while keeping a *failed* wait short
 * enough that the caller's own request has not already given up.
 *
 * ⚠️ **Well under `REFRESH_LOCK_TTL_MS`**, so a context that waits out a dead
 * holder returns, reports `unreachable`, and lets the next attempt find the
 * claim stale and refresh itself — rather than two contexts deciding to
 * proceed at the same moment.
 */
const REFRESH_WAIT_MS = 2_000;
const REFRESH_POLL_MS = 25;

/**
 * Why a refresh did not produce a usable token.
 *
 * `rejected` and `unreachable` must not be conflated: the first means the
 * session is over, the second means the network blinked. Treating them alike
 * signs merchants out of a working dashboard over a dropped connection — which
 * is what the first version of this did, caught by
 * `keeps the session when the refresh request cannot be sent`.
 */
type RefreshOutcome = 'refreshed' | 'rejected' | 'unreachable';

/**
 * Call the API.
 *
 * Unwraps the `{data, meta}` envelope, turns an error body into `ApiError`, and
 * recovers from one expired access token per request.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const response = await send(path, options);

  /*
   * A 401 on a session route is the answer, not a problem to recover from:
   * refreshing after a failed sign-in would replace a clear "wrong password"
   * with a confusing sign-out.
   */
  if (response.status === 401 && !isSessionRoute(path)) {
    const outcome = await refreshOnce();

    if (outcome === 'refreshed') {
      // Once. A second 401 means the new token is rejected too, and retrying
      // again would be a loop that ends in a rate limit.
      return unwrap<T>(await send(path, options));
    }

    if (outcome === 'rejected') {
      /*
       * The session is over: the API refused the refresh token itself. Clearing
       * now means one sign-out rather than every later request failing
       * separately.
       *
       * `unreachable` deliberately falls through: the credentials may still be
       * good, and the caller sees the original failure to retry.
       */
      clearSession();
    }
  }

  return unwrap<T>(response);
}

/** Perform the request, with whatever credential is current. */
async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = new URL(`${BASE_URL}${path}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const token = getAccessToken();

  try {
    return await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    // `fetch` rejects only when the request never completed: offline, DNS
    // failure, CORS refusal. Every HTTP status resolves.
    throw new NetworkError(cause);
  }
}

/**
 * Exchange the refresh token, at most once concurrently.
 *
 * Returns whether the session survived. The caller decides what to do about it,
 * because "sign out" is a routing decision and this module does not route.
 */
async function refreshOnce(): Promise<RefreshOutcome> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Wait for whichever context holds the claim to store a new refresh token.
 *
 * 🔴 **Polls `localStorage` rather than listening for `storage` events.** That
 * event does not fire in the context that wrote the value, and it does not fire
 * at all for a write made before this context finished loading — which is
 * exactly the overlapping-navigation case F64 is about. Polling sees the result
 * whenever it lands.
 *
 * ⚠️ **Bounded, and a timeout is not a rejection.** If the holder dies the wait
 * ends and the caller reports `unreachable`, so the session survives and the
 * next attempt — past the claim's TTL — refreshes normally. Waiting forever
 * would turn a lost tab into a permanent sign-out.
 */
async function waitForRotation(previous: string): Promise<boolean> {
  const deadline = Date.now() + REFRESH_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));

    const current = getRefreshToken();

    /*
     * The holder cleared the session: its refresh was rejected. Reporting
     * "not rotated" lets the caller fail on its own terms rather than
     * presenting a token that is already gone.
     */
    if (current === null) {
      return false;
    }

    if (current !== previous) {
      return true;
    }
  }

  return false;
}

async function performRefresh(): Promise<RefreshOutcome> {
  const refreshToken = getRefreshToken();

  if (refreshToken === null) {
    // Nothing to exchange. Not a rejection — there was no session to lose.
    return 'unreachable';
  }

  /*
   * 🔴 **Another context may already be exchanging this token (F64).**
   * `refreshInFlight` above guards one JS context; a full page navigation
   * empties it while the token in `localStorage` survives, so two contexts
   * each start their own exchange, the second presents a token the first has
   * rotated, and the API revokes the **whole family** as reuse. Measured twice
   * in 95 refreshes, each time signing a merchant out of a working dashboard.
   *
   * ⚠️ **Waiting, not failing.** A blocked context that gave up would trade a
   * revoked session for a broken request — the caller would see a 401 it could
   * do nothing about. It waits for the other context to store the new token
   * and then uses it, which is what the merchant expects to have happened.
   */
  if (refreshIsLocked(getRefreshClaimedAt(), Date.now())) {
    const rotated = await waitForRotation(refreshToken);

    /*
     * 📌 **`unreachable`, not `rejected`, when the wait times out.** The other
     * context may still be in flight; this one has learned nothing about
     * whether the session is valid, and `rejected` would sign the merchant out
     * on no evidence.
     */
    return rotated ? 'refreshed' : 'unreachable';
  }

  setRefreshClaimedAt(Date.now());

  /*
   * 🔴 **Released in `finally`, not at each `return`.** There are four exits
   * below and a later edit adds a fifth; a claim left behind blocks every
   * other context until its TTL expires, and the TTL exists as a backstop
   * rather than as the normal path. Structural release is the difference
   * between a bug and a slow session.
   */
  try {
    return await exchangeRefreshToken(refreshToken);
  } finally {
    setRefreshClaimedAt(null);
  }
}

async function exchangeRefreshToken(refreshToken: string): Promise<RefreshOutcome> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    /*
     * The network failed, which is not the same as the session being invalid.
     * The request that triggered this fails on its own terms, and the tokens
     * are kept for the next attempt.
     */
    return 'unreachable';
  }

  if (!response.ok) {
    // The API looked at the token and refused it. That is a real sign-out.
    return 'rejected';
  }

  const body = (await response.json()) as ApiEnvelope<{
    accessToken: string;
    refreshToken: string;
  }>;

  if (!body?.data?.accessToken || !body?.data?.refreshToken) {
    /*
     * A 200 without both tokens. This is exactly the shape the endpoint had
     * before Phase 13 Stage 1 -- `{ refreshToken }` alone -- so an older API
     * would leave the client holding an expired credential and looping. Treated
     * as a failed refresh rather than trusted.
     */
    return 'rejected';
  }

  setSession(body.data);

  return 'refreshed';
}

/** Turn a `Response` into data, or throw something a caller can act on. */
async function unwrap<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 204) {
    return { data: undefined as T, meta: {} };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      // A success with an unreadable body: nothing to hand back, and nothing
      // wrong either.
      return { data: undefined as T, meta: {} };
    }

    throw new ApiError(response.status, {
      code: 'UNREADABLE_RESPONSE',
      message: 'The server returned something unexpected.',
    });
  }

  if (!response.ok) {
    const error = (body as ApiErrorResponse)?.error;

    throw new ApiError(
      response.status,
      error ?? { code: 'UNKNOWN', message: 'Something went wrong.' },
      (body as ApiErrorResponse)?.meta?.requestId,
    );
  }

  const envelope = body as ApiEnvelope<T>;

  return { data: envelope.data, meta: envelope.meta ?? {} };
}

/** Convenience wrappers. The verb belongs at the call site, not in a string. */
export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
