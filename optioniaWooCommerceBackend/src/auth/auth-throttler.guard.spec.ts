import type { Request } from 'express';

import { AuthThrottlerGuard } from './auth-throttler.guard';

/**
 * The rate-limit key, which decides who shares a budget with whom.
 *
 * Untested until `[8c]`, which is why the store realm could be specified as
 * "60 per hour **per store**" while every store behind one address in fact shared
 * a single IP-keyed bucket. A key is not observable from a passing request, so
 * nothing else would have caught it.
 */
describe('AuthThrottlerGuard', () => {
  /** `getTracker` is protected; the guard is exercised through its own type. */
  const track = (req: Partial<Request>): Promise<string> =>
    (
      new AuthThrottlerGuard(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as { getTracker(r: Request): Promise<string> }
    ).getTracker(req as Request);

  const request = (over: Partial<Request> = {}): Partial<Request> => ({
    ip: '203.0.113.7',
    originalUrl: '/v1/auth/login',
    headers: {},
    body: {},
    ...over,
  });

  describe('the store realm', () => {
    const storeRequest = (token: string, ip = '203.0.113.7'): Partial<Request> =>
      request({
        ip,
        originalUrl: '/v1/store/heartbeat',
        headers: { authorization: `Bearer ${token}` },
      });

    it('keys on the credential, not the address', async () => {
      const first = await track(storeRequest('token-a'));
      const second = await track(storeRequest('token-b'));

      expect(first).not.toBe(second);
    });

    /**
     * The agency case: many shops, one server. An IP key would give all of them
     * one budget, so a busy shop would throttle a quiet one.
     */
    it('separates two stores sharing one address', async () => {
      const one = await track(storeRequest('token-a', '198.51.100.1'));
      const two = await track(storeRequest('token-b', '198.51.100.1'));

      expect(one).not.toBe(two);
    });

    /** And the reverse hole: one store moving between addresses. */
    it('holds one store to a single budget across addresses', async () => {
      const home = await track(storeRequest('token-a', '198.51.100.1'));
      const away = await track(storeRequest('token-a', '203.0.113.9'));

      expect(home).toBe(away);
    });

    /** Keys reach memory dumps and Redis; the credential must not be in them. */
    it('never puts the credential in the key', async () => {
      const key = await track(storeRequest('a-very-secret-token'));

      expect(key).not.toContain('a-very-secret-token');
      expect(key.startsWith('store:')).toBe(true);
    });

    /**
     * A store route with no credential cannot key on one. It falls back to the
     * address, so an unauthenticated flood is still bounded.
     */
    it('falls back to the address when no credential is presented', async () => {
      const key = await track(request({ originalUrl: '/v1/store/heartbeat' }));

      expect(key).toBe('203.0.113.7');
    });
  });

  /**
   * `connect/initiate` is `@Public()`, so its limit is the only thing standing
   * between an open endpoint and a script enumerating shops.
   */
  describe('the connect handshake', () => {
    const initiate = (site: string, ip = '203.0.113.7'): Partial<Request> =>
      request({ ip, originalUrl: '/v1/connect/initiate', body: { site_url: site } });

    it('separates two sites', async () => {
      expect(await track(initiate('https://a.example.com'))).not.toBe(
        await track(initiate('https://b.example.com')),
      );
    });

    it('treats a trailing slash and mixed case as one site', async () => {
      expect(await track(initiate('https://Shop.example.com/'))).toBe(
        await track(initiate('https://shop.example.com')),
      );
    });

    /**
     * The site is caller-controlled, so it is a label and not an identity: the
     * address stays in the key, and both halves must be exhausted.
     */
    it('keeps the address in the key', async () => {
      expect(await track(initiate('https://a.example.com', '198.51.100.1'))).not.toBe(
        await track(initiate('https://a.example.com', '203.0.113.9')),
      );
    });

    it('never puts the site in the key in plaintext', async () => {
      const key = await track(initiate('https://secret-shop.example.com'));

      expect(key).not.toContain('secret-shop');
    });

    /** `authorize` carries a JWT; the tenant is in it, unverified but usable. */
    it('keys authorize on the tenant the token claims', async () => {
      const jwt = (tid: string): string =>
        `x.${Buffer.from(JSON.stringify({ tid }), 'utf8').toString('base64url')}.y`;

      const one = await track(
        request({
          originalUrl: '/v1/connect/authorize',
          headers: { authorization: `Bearer ${jwt('11111111-1111-1111-1111-111111111111')}` },
        }),
      );
      const two = await track(
        request({
          originalUrl: '/v1/connect/authorize',
          headers: { authorization: `Bearer ${jwt('22222222-2222-2222-2222-222222222222')}` },
        }),
      );

      expect(one).not.toBe(two);
      expect(one).toContain(':tenant:');
    });

    /** A malformed token must not throw; it falls back to the address. */
    it('falls back to the address for an unparseable token', async () => {
      const key = await track(
        request({
          originalUrl: '/v1/connect/authorize',
          headers: { authorization: 'Bearer not.a.jwt' },
        }),
      );

      expect(key).toBe('203.0.113.7');
    });

    /** A `tid` that is not a UUID is rejected rather than keyed on. */
    it('ignores a claim that is not a uuid', async () => {
      const payload = Buffer.from(JSON.stringify({ tid: 'x'.repeat(5000) }), 'utf8').toString(
        'base64url',
      );
      const key = await track(
        request({
          originalUrl: '/v1/connect/authorize',
          headers: { authorization: `Bearer a.${payload}.b` },
        }),
      );

      expect(key).toBe('203.0.113.7');
    });
  });

  /**
   * The realm is decided by the route, not by the token's shape. A tenant JWT is
   * an opaque string in the same header, and guessing would key a merchant into
   * the store bucket.
   */
  describe('other realms are unaffected', () => {
    it('does not store-key a tenant route carrying a bearer token', async () => {
      const key = await track(
        request({
          originalUrl: '/v1/option-sets',
          headers: { authorization: 'Bearer a-tenant-jwt' },
        }),
      );

      expect(key).toBe('203.0.113.7');
    });

    it('still keys an account request on address and account', async () => {
      const key = await track(request({ body: { email: 'Someone@Example.com ' } }));

      expect(key).toContain('203.0.113.7:');
      expect(key).not.toContain('someone@example.com');
    });

    it('keys on the address alone when there is no account', async () => {
      expect(await track(request())).toBe('203.0.113.7');
    });

    /** A query string must not change which bucket a request lands in. */
    it('ignores the query string when matching the realm', async () => {
      const key = await track(
        request({
          originalUrl: '/v1/store/heartbeat?retry=1',
          headers: { authorization: 'Bearer token-a' },
        }),
      );

      expect(key.startsWith('store:')).toBe(true);
    });

    /** `/stores` is a tenant route. A prefix match would capture it wrongly. */
    it('does not match a tenant route that merely starts with the same letters', async () => {
      const key = await track(
        request({
          originalUrl: '/v1/stores/abc/credential',
          headers: { authorization: 'Bearer a-tenant-jwt' },
        }),
      );

      expect(key).toBe('203.0.113.7');
    });
  });
});
