import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, setSession } from '@/lib/auth/token-store';
import {
  authorizeConnection,
  describeRequest,
  disconnectStore,
  listStores,
} from './api';

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ data, meta: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** What the request actually sent, so the contract is asserted rather than assumed. */
const sent = (mock: ReturnType<typeof vi.spyOn>) => ({
  url: String((mock.mock.calls[0] as unknown[])[0]),
  init: (mock.mock.calls[0] as unknown[])[1] as RequestInit,
  body: JSON.parse(String(((mock.mock.calls[0] as unknown[])[1] as RequestInit).body ?? '{}')),
});

describe('stores api', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists stores from the documented path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok([{ id: 's-1' }]));

    const stores = await listStores();

    expect(stores).toEqual([{ id: 's-1' }]);
    expect(sent(fetchMock).url).toContain('/v1/stores');
    expect(sent(fetchMock).init.method).toBe('GET');
  });

  /**
   * 🔴 **`state` must be sent, and it is the whole security model.**
   *
   * A pending connection request has **no tenant** — `tenantId` is written at
   * `authorize`, not at `initiate` — so tenant scoping cannot protect it. Keyed
   * on the id alone the endpoint would be a UUID-guessable oracle returning
   * merchants' site URLs. A client that dropped `state` would get a `404` and
   * look like a broken screen; asserting it here names the real cause.
   */
  it('sends both the request id and the state when describing', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ site_url: 'https://acme.example', plugin_version: '1.0.0' }));

    await describeRequest('req-1', 'state-1');

    const request = sent(fetchMock);

    expect(request.url).toContain('/v1/connect/requests/describe');
    expect(request.init.method).toBe('POST');
    expect(request.body).toEqual({ request: 'req-1', state: 'state-1' });
  });

  /**
   * **A POST that reads.** The verb describes the input, not the effect: a secret
   * in a query string lands in browser history, `Referer` headers and logs.
   */
  it('never puts the state in the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

    await describeRequest('req-1', 'super-secret-state');

    expect(sent(fetchMock).url).not.toContain('super-secret-state');
  });

  it('authorizes with both fields and returns the redirect', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ redirect_url: 'https://acme.example/wp-admin/?code=x' }));

    const result = await authorizeConnection('req-1', 'state-1');

    expect(result.redirect_url).toContain('acme.example');
    expect(sent(fetchMock).body).toEqual({ request: 'req-1', state: 'state-1' });
    expect(sent(fetchMock).url).toContain('/v1/connect/authorize');
  });

  it('disconnects by id and reports what was revoked', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ status: 'disconnected', credentials_revoked: 2 }));

    const result = await disconnectStore('store-9');

    expect(result.credentials_revoked).toBe(2);
    expect(sent(fetchMock).url).toContain('/v1/stores/store-9/disconnect');
    expect(sent(fetchMock).init.method).toBe('POST');
  });

  /** Every call carries the access token, or the API answers 401. */
  it.each([
    ['listStores', () => listStores()],
    ['describeRequest', () => describeRequest('r', 's')],
    ['authorizeConnection', () => authorizeConnection('r', 's')],
    ['disconnectStore', () => disconnectStore('s-1')],
  ])('%s sends the access token', async (_label, call) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

    await call();

    const headers = sent(fetchMock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
  });
});
