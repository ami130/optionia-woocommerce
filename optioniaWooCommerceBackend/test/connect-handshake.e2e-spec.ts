import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The connection handshake, `initiate` → `authorize` (M8.1, M8.2, `[8d]`).
 *
 * `exchange` is `[8e]`; this suite ends where the merchant's approval does.
 */
describe('connect handshake (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  let token = '';
  let tenantId = '';

  /**
   * `exchange` runs a full handshake per test, and `authorize` is capped at 30
   * per hour **per tenant** — a limit `[8d]` implemented deliberately. The suite
   * outgrew that budget the moment `[8e]` arrived, and every later test then
   * failed with a `429` that had nothing to do with what it asserted.
   *
   * A second tenant is the honest fix: it mirrors what really happens (each
   * merchant has their own budget) and keeps the limit at its specified value
   * rather than loosening a security control to suit a test suite.
   */
  let exchangeToken = '';
  let exchangeTenantId = '';

  /**
   * A distinct site per call.
   *
   * `initiate` is limited to 10 per hour **per site URL**, and `@Throttle`
   * hard-codes that — `setup-e2e.ts` raises the global buckets but cannot lift a
   * per-route override. A suite reusing one URL exhausts the bucket partway
   * through and every later test fails with a `429` that has nothing to do with
   * what it was asserting. Varying the site is also what makes these tests
   * independent of their order.
   *
   * The limit itself is asserted deliberately in its own test below.
   */
  let siteCounter = 0;
  const SITE_PREFIX = 'https://connect8d-';
  const nextSite = (): string => `${SITE_PREFIX}${(siteCounter += 1)}.example.com`;

  /** 43 base64url characters — the length of one SHA-256 digest. */
  const digest = (): string => randomBytes(32).toString('base64url');

  const initiate = (body: Record<string, unknown> = {}): request.Test => {
    const site = (body.site_url as string | undefined) ?? nextSite();

    return request(app.getHttpServer())
      .post('/v1/connect/initiate')
      .send({
        site_url: site,
        callback: `${site}/wp-admin/admin.php?page=optionia-connect`,
        state: digest(),
        challenge: digest(),
        plugin_version: '1.0.0',
        ...body,
      });
  };

  const describeRequest = (body: Record<string, unknown>, bearer = token): request.Test =>
    request(app.getHttpServer())
      .post('/v1/connect/requests/describe')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

  const authorize = (body: Record<string, unknown>, bearer = token): request.Test =>
    request(app.getHttpServer())
      .post('/v1/connect/authorize')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

  /** Run a full `initiate`, returning the request id and the plaintext state. */
  async function begin(
    over: Record<string, unknown> = {},
  ): Promise<{ request: string; state: string; site: string }> {
    const state = digest();
    const site = (over.site_url as string | undefined) ?? nextSite();
    const response = await initiate({ state, site_url: site, ...over });

    if (response.status !== 200) {
      throw new Error(
        `initiate failed: ${response.status} ${JSON.stringify(response.body?.error ?? response.body)}`,
      );
    }

    const url = new URL(response.body.data.authorize_url);

    return { request: url.searchParams.get('request') ?? '', state, site };
  }

  /**
   * Remove only the handshakes this suite created.
   *
   * Scoped by the suite's own site prefix, not by `%example.com%`: every suite
   * uses that domain, and a cleanup matching it would delete another suite's
   * rows mid-run. That is the shape of the orphaned-tenant bug the harness
   * docstring records, and the reason every `DELETE` in `test/` is namespace-
   * scoped.
   *
   * `store_connection_codes` cascades from both `tenants` and `stores`, so the
   * harness's own cleanup already removes anything that reached a tenant; this
   * catches the pending rows that never did.
   */
  async function removeCodes(): Promise<void> {
    await dataSource.query(`DELETE FROM store_connection_codes WHERE siteUrl LIKE ?`, [
      `${SITE_PREFIX}%`,
    ]);
  }

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('connect8d');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await removeCodes();

    token = await harness.tenant('a');
    tenantId = await harness.tenantIdOf('a');

    exchangeToken = await harness.tenant('x');
    exchangeTenantId = await harness.tenantIdOf('x');
  }, 120_000);

  afterAll(async () => {
    await removeCodes();
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  describe('initiate', () => {
    it('returns an authorize_url carrying the request and the state', async () => {
      const state = digest();
      const response = await initiate({ state });

      expect(response.status).toBe(200);

      const url = new URL(response.body.data.authorize_url);

      expect(url.pathname).toBe('/connect');
      expect(url.searchParams.get('request')).toHaveLength(36);
      expect(url.searchParams.get('state')).toBe(state);
    });

    /**
     * The plaintext must reach the browser and never the database — the two
     * halves of the same decision.
     */
    it('stores only the hash of state', async () => {
      const state = digest();
      const { request: id } = await begin({ state });

      const [row] = await dataSource.query(
        `SELECT stateHash FROM store_connection_codes WHERE id = ?`,
        [id],
      );

      expect(row.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
      expect(row.stateHash).not.toBe(state);
    });

    /** Already a digest; hashing it again would make PKCE unverifiable. */
    it('stores the challenge exactly as sent', async () => {
      const challenge = digest();
      const { request: id } = await begin({ challenge });

      const [row] = await dataSource.query(
        `SELECT challenge FROM store_connection_codes WHERE id = ?`,
        [id],
      );

      expect(row.challenge).toBe(challenge);
    });

    it('is reachable without any credential', async () => {
      expect((await initiate()).status).toBe(200);
    });

    describe('refuses', () => {
      /**
       * Each field is refused on its own.
       *
       * An earlier version sent `http://` for both, which passed whichever rule
       * fired first and would have passed with the `site_url` rule removed
       * entirely — verified by mutation. A credential must never cross a
       * plaintext connection, and both halves of the round trip carry one.
       */
      it('a plaintext site_url, with an https callback', async () => {
        const response = await initiate({
          site_url: 'http://shop-plain.example.com',
          callback: 'https://shop-plain.example.com/cb',
        });

        expect(response.status).toBe(400);
      });

      /**
       * Both fields plaintext, with **matching origins** — the case the origin
       * check cannot catch and only the scheme rules refuse.
       *
       * The two tests above each pass on the origin comparison instead: an
       * `http://` site and an `https://` callback differ in protocol, and
       * protocol is part of an origin. Verified by mutation — relaxing both
       * scheme rules to `https?` broke nothing until this test existed, while a
       * credential would have been delivered over a plaintext connection.
       */
      it('a plaintext site_url and callback on the same origin', async () => {
        const response = await initiate({
          site_url: 'http://plain-both.example.com',
          callback: 'http://plain-both.example.com/cb',
        });

        expect(response.status).toBe(400);
      });

      it('a plaintext callback, with an https site_url', async () => {
        const site = nextSite();
        const response = await initiate({
          site_url: site,
          callback: `${site.replace('https://', 'http://')}/cb`,
        });

        expect(response.status).toBe(400);
      });

      /**
       * The open-redirect case. A prefix check would admit this — the value
       * *starts with* the site URL and is a different host entirely.
       */
      /**
       * The open-redirect case, and the reason the check compares **origins**
       * rather than prefixes.
       *
       * The lookalike is built from *this call's* site URL, so it genuinely
       * starts with it as a string: `https://shop-4.example.com` and
       * `https://shop-4.example.com.evil.test` share a prefix and share no host.
       * A hardcoded lookalike would pass this test against a prefix check, which
       * is what an earlier version of it did.
       */
      it('a callback on a host that merely starts with the site URL', async () => {
        const site = nextSite();
        const response = await initiate({
          site_url: site,
          callback: `${site}.evil.test/steal`,
        });

        expect(response.status).toBe(400);
      });

      it('a callback on an unrelated origin', async () => {
        const response = await initiate({ callback: 'https://evil.test/steal' });

        expect(response.status).toBe(400);
      });

      /** A `plain` PKCE challenge is a downgrade S256 exists to prevent. */
      it('a challenge that is not one digest long', async () => {
        expect((await initiate({ challenge: 'short' })).status).toBe(400);
      });

      it('a state below the entropy floor', async () => {
        expect((await initiate({ state: 'too-short' })).status).toBe(400);
      });

      it('an unknown field', async () => {
        expect((await initiate({ extra: 'x' })).status).toBe(400);
      });
    });
  });

  /**
   * What the approval screen shows before a merchant consents (M13.3).
   *
   * 🔴 Nothing exposed the pending request's `siteUrl`, so the screen could only
   * ask *"approve this?"* without saying **what** — on a screen whose entire
   * purpose is consent.
   */
  describe('describe', () => {
    it('names the site and plugin asking to connect', async () => {
      const handshake = await begin();

      const response = await describeRequest({
        request: handshake.request,
        state: handshake.state,
      });

      expect(response.status).toBe(200);
      expect(response.body.data.site_url).toBe(handshake.site);
      expect(response.body.data.plugin_version).toBe('1.0.0');
      expect(typeof response.body.data.expires_at).toBe('string');
    }, 30_000);

    /**
     * **A read, not a claim.** A merchant may reload the approval screen; only
     * `authorize` consumes the request.
     */
    it('does not consume the request', async () => {
      const handshake = await begin();

      await describeRequest({ request: handshake.request, state: handshake.state }).expect(200);
      await describeRequest({ request: handshake.request, state: handshake.state }).expect(200);

      const approved = await authorize({
        request: handshake.request,
        state: handshake.state,
      });

      expect(approved.status).toBe(200);
    }, 30_000);

    /**
     * 🔴 **The `state` is what stops this being an oracle.**
     *
     * A pending request has **no tenant** — `tenantId` is written at `authorize`
     * — so tenant scoping cannot protect it, and a read keyed on the id alone
     * would let any signed-in user walk UUIDs and collect merchants' site URLs.
     * Holding the id must not be enough.
     */
    it('refuses a correct id with the wrong state', async () => {
      const handshake = await begin();

      const response = await describeRequest({ request: handshake.request, state: digest() });

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(handshake.site);
    }, 30_000);

    /**
     * **Every refusal is the same 404**, and the body never names a site.
     *
     * Distinguishing unknown from expired from already-approved would restore
     * the enumeration this endpoint is shaped to prevent — and unlike
     * `authorize`, this one *returns data*, so the prize for guessing is a
     * merchant's URL.
     */
    it('answers unknown, approved and wrong-state identically', async () => {
      const handshake = await begin();

      const unknown = await describeRequest({
        request: '00000000-0000-4000-8000-000000000000',
        state: handshake.state,
      });

      const wrongState = await describeRequest({ request: handshake.request, state: digest() });

      await authorize({ request: handshake.request, state: handshake.state }).expect(200);
      const alreadyApproved = await describeRequest({
        request: handshake.request,
        state: handshake.state,
      });

      for (const response of [unknown, wrongState, alreadyApproved]) {
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe(unknown.body.error.code);
        expect(response.body.error.message).toBe(unknown.body.error.message);
      }
    }, 60_000);

    it('refuses an expired request', async () => {
      const handshake = await begin();

      await harness.dataSource.query(
        `UPDATE store_connection_codes SET requestExpiresAt = DATE_SUB(NOW(3), INTERVAL 1 MINUTE)
          WHERE id = ?`,
        [handshake.request],
      );

      await describeRequest({ request: handshake.request, state: handshake.state }).expect(404);
    }, 30_000);

    it('refuses an unauthenticated caller', async () => {
      const handshake = await begin();

      await request(app.getHttpServer())
        .post('/v1/connect/requests/describe')
        .send({ request: handshake.request, state: handshake.state })
        .expect(401);
    }, 30_000);

    it('refuses a malformed request id', async () => {
      await describeRequest({ request: 'not-a-uuid', state: digest() }).expect(400);
    }, 30_000);
  });

  describe('authorize', () => {
    it('approves a pending request and redirects to the callback', async () => {
      const begun = await begin();
      const { request: id, state } = begun;
      const response = await authorize({ request: id, state });

      expect(response.status).toBe(200);

      const url = new URL(response.body.data.redirect_url);

      expect(url.origin).toBe(new URL(begun.site).origin);
      expect(url.searchParams.get('state')).toBe(state);
      expect(url.searchParams.get('code')).toBeTruthy();
    });

    it('creates the store in CONNECTING, owned by the approving tenant', async () => {
      const { request: id, state } = await begin();

      await authorize({ request: id, state });

      const [row] = await dataSource.query(
        `SELECT s.status, s.tenantId FROM stores s
           JOIN store_connection_codes c ON c.storeId = s.id WHERE c.id = ?`,
        [id],
      );

      expect(row.status).toBe(StoreStatus.CONNECTING);
      expect(row.tenantId).toBe(tenantId);
    });

    /** The code is a secret: only its hash may reach the table. */
    it('stores only the hash of the code', async () => {
      const { request: id, state } = await begin();
      const response = await authorize({ request: id, state });
      const code = new URL(response.body.data.redirect_url).searchParams.get('code') ?? '';

      const [row] = await dataSource.query(
        `SELECT codeHash, codeExpiresAt, approvedAt FROM store_connection_codes WHERE id = ?`,
        [id],
      );

      expect(row.codeHash).toBe(createHash('sha256').update(code).digest('hex'));
      expect(row.approvedAt).not.toBeNull();
      expect(row.codeExpiresAt).not.toBeNull();
    });

    describe('refuses', () => {
      /**
       * A well-formed id that names nothing. `401`, not `404`: a caller must not
       * learn which request ids exist, which is what makes enumeration useless.
       */
      it('a well-formed request id that does not exist', async () => {
        const response = await authorize({
          request: '01a0432e-6d22-716e-80a2-643aea24dfb2',
          state: digest(),
        });

        expect(response.status).toBe(401);
      });

      /**
       * A malformed id is `400` from validation, before the lookup.
       *
       * Distinct from the case above and deliberately so: the two answer
       * different questions ("is this shaped like an id" and "does it name
       * anything"), and only the second could leak existence. Asserted because a
       * single test covering both would pass whichever code the route returned.
       */
      it('a malformed request id', async () => {
        const response = await authorize({ request: 'not-a-uuid', state: digest() });

        expect(response.status).toBe(400);
      });

      /** The CSRF check: a request approved with the wrong state is not this one. */
      it('a state that does not match the stored hash', async () => {
        const { request: id } = await begin();
        const response = await authorize({ request: id, state: digest() });

        expect(response.status).toBe(401);
      });

      it('an expired request', async () => {
        const { request: id, state } = await begin();

        await dataSource.query(
          `UPDATE store_connection_codes SET requestExpiresAt = NOW(3) - INTERVAL 1 SECOND WHERE id = ?`,
          [id],
        );

        expect((await authorize({ request: id, state })).status).toBe(401);
      });

      /** Approving twice must not mint two codes. */
      it('a second approval of the same request', async () => {
        const { request: id, state } = await begin();

        expect((await authorize({ request: id, state })).status).toBe(200);
        expect((await authorize({ request: id, state })).status).toBe(401);
      });

      /**
       * The same rule under concurrency, which is the case the conditional
       * `UPDATE … WHERE approvedAt IS NULL` actually exists for.
       *
       * The sequential test above passes on the read-side pre-check alone —
       * verified by mutation: removing the conditional broke nothing until this
       * test existed. Two simultaneous approvals both pass that pre-check,
       * because neither has committed when the other reads, and only the
       * conditional write decides between them.
       */
      it('two simultaneous approvals, of which exactly one succeeds', async () => {
        const { request: id, state } = await begin();

        const results = await Promise.all([
          authorize({ request: id, state }),
          authorize({ request: id, state }),
          authorize({ request: id, state }),
        ]);

        const statuses = results.map((result) => result.status);

        expect(statuses.filter((status) => status === 200)).toHaveLength(1);

        // And exactly one code was minted, not three.
        const [row] = await dataSource.query(
          `SELECT codeHash FROM store_connection_codes WHERE id = ?`,
          [id],
        );

        expect(row.codeHash).not.toBeNull();
      });

      it('a caller with no token', async () => {
        const { request: id, state } = await begin();
        const response = await request(app.getHttpServer())
          .post('/v1/connect/authorize')
          .send({ request: id, state });

        expect(response.status).toBe(401);
      });

      /** Connecting a storefront is an ownership act, not an authoring one. */
      it('a member without stores:connect', async () => {
        const viewer = await harness.tenant('viewer');

        await dataSource.query(
          `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
              SET tm.role = 'viewer' WHERE u.email = ?`,
          ['connect8d-viewer@example.com'],
        );

        const { request: id, state } = await begin();
        const response = await authorize({ request: id, state }, viewer);

        expect(response.status).toBe(403);
      });
    });

    /**
     * Reconnection is the recovery path M8.1b names, not an error:
     * `REVOKED → DISCONNECTED → CONNECTING` on the row that already exists.
     */
    describe('reconnecting', () => {
      const RECONNECT = `${SITE_PREFIX}reconnect.example.com`;

      /**
       * Reuse is scoped by tenant, and that is a security boundary rather than a
       * lookup detail.
       *
       * `uq_stores_tenant_url` is `(tenant_id, store_url)` precisely because two
       * tenants may legitimately hold the same address — an agency and its
       * client. A reuse lookup keyed on URL alone would hand one tenant's
       * approval the other tenant's store, which is a cross-tenant write.
       * Verified by mutation: dropping `tenantId` from that query broke nothing
       * until this test existed.
       */
      it('does not reuse another tenant\u2019s store at the same URL', async () => {
        const shared = nextSite();

        const mine = await begin({ site_url: shared });

        await authorize({ request: mine.request, state: mine.state });

        const otherToken = await harness.tenant('b');
        const otherTenant = await harness.tenantIdOf('b');
        const theirs = await begin({ site_url: shared });

        expect(
          (await authorize({ request: theirs.request, state: theirs.state }, otherToken)).status,
        ).toBe(200);

        const rows = await dataSource.query(
          `SELECT id, tenantId FROM stores WHERE storeUrl = ? ORDER BY tenantId`,
          [shared],
        );

        // Two stores, one per tenant — not one row seized by the second caller.
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row: { tenantId: string }) => row.tenantId))).toEqual(
          new Set([tenantId, otherTenant]),
        );
      });

      it('reuses the store row rather than creating a second', async () => {
        const first = await begin({
          site_url: RECONNECT,
          callback: `${RECONNECT}/cb`,
        });

        await authorize({ request: first.request, state: first.state });

        const [before] = await dataSource.query(
          `SELECT id FROM stores WHERE tenantId = ? AND storeUrl = ?`,
          [tenantId, RECONNECT],
        );

        await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
          StoreStatus.REVOKED,
          before.id,
        ]);

        const second = await begin({
          site_url: RECONNECT,
          callback: `${RECONNECT}/cb`,
        });

        expect((await authorize({ request: second.request, state: second.state })).status).toBe(
          200,
        );

        const rows = await dataSource.query(
          `SELECT id, status FROM stores WHERE tenantId = ? AND storeUrl = ?`,
          [tenantId, RECONNECT],
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(before.id);
        expect(rows[0].status).toBe(StoreStatus.CONNECTING);
      });
    });
  });

  /**
   * `initiate` is `@Public()`, so its limit is the whole of its defence.
   *
   * Asserted end to end rather than at the key function: a correct key against a
   * bucket that never fires is indistinguishable from a working limit, and this
   * codebase has shipped exactly that — `@Throttle({ default: … })` once
   * overrode a bucket that did not exist, so 25 requests passed a declared limit
   * of 5.
   */
  describe('rate limiting', () => {
    it('refuses an eleventh attempt for one site, and leaves another site free', async () => {
      const site = nextSite();
      const codes: number[] = [];

      for (let attempt = 0; attempt < 12; attempt += 1) {
        codes.push((await initiate({ site_url: site })).status);
      }

      expect(codes.filter((code) => code === 200)).toHaveLength(10);
      expect(codes.at(-1)).toBe(429);

      // A different site is a different bucket: one noisy install must not
      // throttle every other shop behind the same address.
      expect((await initiate({ site_url: nextSite() })).status).toBe(200);
    }, 60_000);
  });

  /**
   * `exchange` — the plugin redeems its code for a credential (`[8e]`).
   *
   * The only irreversible step: it mints a long-lived secret and moves the store
   * to `CONNECTED`.
   */
  describe('exchange', () => {
    /** Run the whole handshake and return what the plugin would now hold. */
    async function approved(
      over: Record<string, unknown> = {},
    ): Promise<{ code: string; verifier: string; site: string; storeId: string }> {
      const verifier = digest();
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const begun = await begin({ challenge, ...over });

      // The exchange block's own tenant: `authorize` is 30/hour per tenant, and
      // one full handshake per test would otherwise exhaust the suite's budget.
      const response = await authorize(
        { request: begun.request, state: begun.state },
        exchangeToken,
      );

      if (response.status !== 200) {
        throw new Error(
          `authorize failed: ${response.status} ` +
            `${JSON.stringify(response.body?.error ?? response.body)}`,
        );
      }

      const code = new URL(response.body.data.redirect_url).searchParams.get('code') ?? '';

      const [row] = await dataSource.query(
        `SELECT storeId FROM store_connection_codes WHERE id = ?`,
        [begun.request],
      );

      return { code, verifier, site: begun.site, storeId: row.storeId };
    }

    const exchange = (body: Record<string, unknown>): request.Test =>
      request(app.getHttpServer()).post('/v1/connect/exchange').send(body);

    it('returns a credential and the tenant it belongs to', async () => {
      const { code, verifier, site } = await approved();
      const response = await exchange({ code, verifier, site_url: site });

      expect(response.status).toBe(200);
      expect(response.body.data.token).toMatch(/^osk_live_/);
      expect(response.body.data.tenant_name).toBeTruthy();
      expect(response.body.data.config_version).toBe(0);
    });

    it('moves the store to CONNECTED and stamps connectedAt', async () => {
      const { code, verifier, site, storeId } = await approved();

      await exchange({ code, verifier, site_url: site });

      const [row] = await dataSource.query(
        `SELECT status, connectedAt FROM stores WHERE id = ?`,
        [storeId],
      );

      expect(row.status).toBe(StoreStatus.CONNECTED);
      // The column existed from the initial schema and nothing wrote it, so
      // "connected since when?" had no answer for any store.
      expect(row.connectedAt).not.toBeNull();
    });

    /**
     * The transition M8.1b's machine exists to refuse.
     *
     * A code redeemed after the merchant disconnected must not silently
     * reconnect the store — reachable with no attacker: a failed exchange the
     * plugin retries, and an impatient merchant clicking Disconnect in between.
     */
    it('refuses to reconnect a store the merchant disconnected', async () => {
      const { code, verifier, site, storeId } = await approved();

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.DISCONNECTED,
        storeId,
      ]);

      expect((await exchange({ code, verifier, site_url: site })).status).toBe(401);

      const [row] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [storeId]);

      expect(row.status).toBe(StoreStatus.DISCONNECTED);
    });

    /** And the same for a store the cloud revoked. */
    it('refuses to reconnect a revoked store', async () => {
      const { code, verifier, site, storeId } = await approved();

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.REVOKED,
        storeId,
      ]);

      expect((await exchange({ code, verifier, site_url: site })).status).toBe(401);
    });

    /**
     * Refusing must not spend the code.
     *
     * If it did, a merchant who disconnected mid-handshake could never redeem
     * the code they legitimately hold — the refusal would consume it.
     */
    it('leaves the code unspent when the transition is refused', async () => {
      const { code, verifier, site, storeId } = await approved();

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.DISCONNECTED,
        storeId,
      ]);

      await exchange({ code, verifier, site_url: site });

      const [row] = await dataSource.query(
        `SELECT redeemedAt FROM store_connection_codes WHERE codeHash = ?`,
        [createHash('sha256').update(code).digest('hex')],
      );

      expect(row.redeemedAt).toBeNull();
    });

    /** The token is shown once; only its hash may reach the table. */
    it('stores only the hash, and a prefix that discriminates', async () => {
      const { code, verifier, site, storeId } = await approved();
      const response = await exchange({ code, verifier, site_url: site });
      const token = response.body.data.token as string;

      const [row] = await dataSource.query(
        `SELECT tokenHash, tokenPrefix FROM store_credentials WHERE storeId = ?`,
        [storeId],
      );

      expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      // Not `osk_live` — that is the same for every credential ever issued.
      expect(row.tokenPrefix).not.toBe('osk_live');
      expect(token).toContain(row.tokenPrefix);
    });

    /**
     * The credential works. Without this the suite proves a token was minted,
     * not that it authenticates anything.
     */
    it('issues a credential the store realm accepts', async () => {
      const { code, verifier, site } = await approved();
      const token = (await exchange({ code, verifier, site_url: site })).body.data.token;

      const [row] = await dataSource.query(
        `SELECT revokedAt FROM store_credentials WHERE tokenHash = ?`,
        [createHash('sha256').update(token).digest('hex')],
      );

      expect(row).toBeDefined();
      expect(row.revokedAt).toBeNull();
    });

    /**
     * `initiate` normalises the URL it stores and WordPress reports
     * `home_url( '/' )` with a trailing slash, so "exactly" has to mean exactly
     * after the same reduction — otherwise every honest exchange is refused.
     */
    it('accepts the trailing slash WordPress actually sends', async () => {
      const { code, verifier, site } = await approved();
      const response = await exchange({ code, verifier, site_url: `${site}/` });

      expect(response.status).toBe(200);
    });

    describe('refuses', () => {
      it('an unknown code', async () => {
        const { verifier, site } = await approved();

        expect((await exchange({ code: digest(), verifier, site_url: site })).status).toBe(401);
      });

      /** Single-use: the second redemption of one code must fail. */
      it('a code already spent', async () => {
        const { code, verifier, site } = await approved();

        expect((await exchange({ code, verifier, site_url: site })).status).toBe(200);
        expect((await exchange({ code, verifier, site_url: site })).status).toBe(401);
      });

      /** The same rule under concurrency, which is what the conditional write is for. */
      it('all but one of three simultaneous redemptions', async () => {
        const { code, verifier, site } = await approved();

        const results = await Promise.all([
          exchange({ code, verifier, site_url: site }),
          exchange({ code, verifier, site_url: site }),
          exchange({ code, verifier, site_url: site }),
        ]);

        expect(results.filter((result) => result.status === 200)).toHaveLength(1);

        const rows = await dataSource.query(
          `SELECT c.id FROM store_credentials sc
             JOIN store_connection_codes c ON c.storeId = sc.storeId
            WHERE c.codeHash = ?`,
          [createHash('sha256').update(code).digest('hex')],
        );

        // One credential, not three.
        expect(rows).toHaveLength(1);
      });

      it('an expired code', async () => {
        const { code, verifier, site } = await approved();

        await dataSource.query(
          `UPDATE store_connection_codes SET codeExpiresAt = NOW(3) - INTERVAL 1 SECOND
            WHERE codeHash = ?`,
          [createHash('sha256').update(code).digest('hex')],
        );

        expect((await exchange({ code, verifier, site_url: site })).status).toBe(401);
      });

      /** PKCE: the code alone is not enough without the verifier that made it. */
      it('a wrong verifier', async () => {
        const { code, site } = await approved();

        expect((await exchange({ code, verifier: digest(), site_url: site })).status).toBe(401);
      });

      /**
       * The challenge is case-sensitive base64url. Under the schema-wide
       * `utf8mb4_unicode_ci` this comparison would succeed — which is why the
       * column is `utf8mb4_bin` (`[8b]`).
       */
      it('a verifier whose challenge differs only in case', async () => {
        const { code, verifier, site } = await approved();
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const swapped = challenge
          .split('')
          .map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))
          .join('');

        await dataSource.query(
          `UPDATE store_connection_codes SET challenge = ? WHERE codeHash = ?`,
          [swapped, createHash('sha256').update(code).digest('hex')],
        );

        expect((await exchange({ code, verifier, site_url: site })).status).toBe(401);
      });

      /** A code issued for one shop must not be redeemable by another. */
      it('a different site', async () => {
        const { code, verifier } = await approved();

        expect((await exchange({ code, verifier, site_url: nextSite() })).status).toBe(401);
      });

      it('a malformed verifier', async () => {
        const { code, site } = await approved();

        expect((await exchange({ code, verifier: 'short', site_url: site })).status).toBe(400);
      });

      it('an unknown field', async () => {
        const { code, verifier, site } = await approved();

        expect(
          (await exchange({ code, verifier, site_url: site, extra: 'x' })).status,
        ).toBe(400);
      });
    });

    /** M8.1b: the completing transition is logged, against the right tenant. */
    it('audits the connection against the tenant from the code', async () => {
      const { code, verifier, site, storeId } = await approved();

      await exchange({ code, verifier, site_url: site });

      const [row] = await dataSource.query(
        `SELECT action, tenantId, resourceId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.connected' LIMIT 1`,
        [storeId],
      );

      expect(row).toBeDefined();
      expect(row.tenantId).toBe(exchangeTenantId);
    });
  });

  /** M8.1b: every transition of a store is logged. */
  describe('audit', () => {
    it('records the connection against the tenant', async () => {
      const { request: id, state } = await begin({
        site_url: `${SITE_PREFIX}audited.example.com`,
        callback: `${SITE_PREFIX}audited.example.com/cb`,
      });

      await authorize({ request: id, state });

      const [store] = await dataSource.query(
        `SELECT storeId FROM store_connection_codes WHERE id = ?`,
        [id],
      );

      /**
       * Matched on **this** store, not on the newest `store.%` row.
       *
       * An `ORDER BY createdAt DESC LIMIT 1` assumed no other store event could
       * land in between, which stopped being true the moment `[8e]` added
       * `store.connected` — the test then read another test's row. Scoping to the
       * resource makes it independent of what else the suite does.
       */
      const [row] = await dataSource.query(
        `SELECT action, resourceType, tenantId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.connect_authorized' LIMIT 1`,
        [store.storeId],
      );

      expect(row).toBeDefined();
      expect(row.action).toBe('store.connect_authorized');
      expect(row.resourceType).toBe('store');
      expect(row.tenantId).toBe(tenantId);
    });

    /**
     * A store appearing between `initiate` and `authorize` is reused, not duplicated.
     *
     * `AuditService` writes through its own repository, on a connection separate
     * from the transaction, so an entry recorded *inside* the callback survives a
     * rollback and reports a connection that never happened. A phantom row is
     * worse than a missing one — it sends whoever reads the trail looking for a
     * store that does not exist.
     *
     * The rollback is forced through the one race the code genuinely has:
     * `createOrReuseStore` looks for an existing store and inserts when it finds
     * none, and `uq_stores_tenant_url` is `(tenant_id, store_url)`. Creating that
     * row **after** `initiate` but **before** `authorize` is indistinguishable
     * from another request winning the race, and the insert then violates the
     * constraint and aborts the transaction.
     */
    it('reuses a store created between initiate and authorize, auditing it as a reconnect', async () => {
      const site = `${SITE_PREFIX}rollback.example.com`;
      const { request: id, state } = await begin({ site_url: site, callback: `${site}/cb` });

      const countRows = async (): Promise<number> => {
        const [row] = await dataSource.query(
          `SELECT COUNT(*) AS n FROM audit_logs WHERE tenantId = ? AND action LIKE 'store.%'`,
          [tenantId],
        );

        return Number(row.n);
      };

      const before = await countRows();

      /**
       * The racing writer, inserted directly.
       *
       * `status` is left `disconnected` so the row is not one `authorize` would
       * reuse had it seen it — the point is that it appears only after the
       * lookup, which is what a real concurrent approval does.
       */
      await dataSource.query(
        `INSERT INTO stores (id, createdAt, updatedAt, tenantId, platform, name, storeUrl,
                             status, configVersion)
         VALUES (UUID(), NOW(3), NOW(3), ?, 'woocommerce', 'racer', ?, 'disconnected', 0)`,
        [tenantId, site],
      );

      // The approval now finds a store and reuses it, which is the correct
      // outcome and not a rollback — so the audit row is the *reconnect* one.
      const response = await authorize({ request: id, state });

      expect(response.status).toBe(200);

      const after = await countRows();

      // Exactly one entry, and it names the reuse rather than a fresh connect.
      expect(after).toBe(before + 1);

      const [reconnect] = await dataSource.query(
        `SELECT action FROM audit_logs
          WHERE tenantId = ? AND action = 'store.reconnect_authorized'
            AND JSON_EXTRACT(changes, '$.siteUrl') = ? LIMIT 1`,
        [tenantId, site],
      );

      expect(reconnect).toBeDefined();
      expect(reconnect.action).toBe('store.reconnect_authorized');
    });
  });

  /**
   * Where the cloud pushes "new configuration is available" (M9.4).
   *
   * Validated here because `initiate` is where it arrives. That it reaches the
   * *store* is asserted in `phase-8-acceptance`, which runs a full handshake.
   */
  describe('the push URL', () => {
    /**
     * It must share the site's origin, for longer-lived reasons than `callback`.
     *
     * `callback` receives one code and expires with the handshake. This is
     * stored on the store and receives every push from then on — an attacker
     * who slipped in their own host would be told whenever that merchant
     * publishes, indefinitely.
     */
    it('is refused when it points at another origin', async () => {
      const response = await initiate({
        push_url: 'https://attacker.example.com/wp-json/optionia/v1/push',
      });

      expect(response.status).toBe(400);
    });

    /**
     * A prefix check would accept `https://shop.example.com.evil.test`, which is
     * a different host — the same trap the callback check documents.
     */
    it('is refused when the origin merely starts with the site URL', async () => {
      const site = nextSite();

      const response = await initiate({
        site_url: site,
        push_url: `${site}.evil.test/wp-json/optionia/v1/push`,
      });

      expect(response.status).toBe(400);
    });

    /** Must be absolute https, like every other URL this endpoint accepts. */
    it('is refused when it is not https', async () => {
      const site = nextSite();

      const response = await initiate({
        site_url: site,
        push_url: site.replace('https://', 'http://') + '/wp-json/optionia/v1/push',
      });

      expect(response.status).toBe(400);
    });

    /**
     * A plugin build predating the route still connects.
     *
     * The push is a latency improvement over the fifteen-minute pull, so a store
     * without one is behind by minutes rather than broken. Refusing the
     * handshake would turn an optional optimisation into a hard dependency.
     */
    it('is optional', async () => {
      expect((await initiate()).status).toBe(200);
    });

    it('is accepted when it shares the site origin', async () => {
      const site = nextSite();

      const response = await initiate({
        site_url: site,
        push_url: `${site}/wp-json/optionia/v1/push`,
      });

      expect(response.status).toBe(200);
    });
  });
});
