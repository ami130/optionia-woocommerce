import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Phase 8's exit criteria, driven end to end.
 *
 * ## Why this exists alongside the per-step suites
 *
 * `connect-handshake`, `store-ownership` and `store-heartbeat` each prove their
 * own step. None of them proves a **criterion**, because every criterion spans
 * steps: a merchant connecting a store touches `[8d]`, `[8e]` and `[8f]`; a clone
 * being refused touches `[8c]`, `[8f]` and `[8i]`.
 *
 * The coverage existed before this file and was scattered across four suites, so
 * "Phase 8 is done" rested on someone's assertion rather than on something
 * executable. That is the same failure as a criterion with no owner — which
 * happened three times in this phase with audit actions — and the fix is the same:
 * make the claim run.
 *
 * **It deliberately does not re-assert units.** Each test below is a scenario the
 * step suites cannot express, driven through the real endpoints in the order a
 * plugin and a merchant would.
 */
describe('Phase 8 exit criteria (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  let merchant = '';
  let tenantId = '';

  const digest = (): string => randomBytes(32).toString('base64url');
  const SITE_PREFIX = 'https://ph8-';

  let counter = 0;
  const nextSite = (): string => `${SITE_PREFIX}${(counter += 1)}.example.com`;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('ph8');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await dataSource.query(`DELETE FROM store_connection_codes WHERE siteUrl LIKE ?`, [
      `${SITE_PREFIX}%`,
    ]);

    merchant = await harness.tenant('a');
    tenantId = await harness.tenantIdOf('a');
  }, 120_000);

  afterAll(async () => {
    await dataSource?.query(`DELETE FROM store_connection_codes WHERE siteUrl LIKE ?`, [
      `${SITE_PREFIX}%`,
    ]);
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /**
   * The whole handshake, exactly as a plugin and a merchant perform it.
   *
   * Returns everything a connected store holds afterwards, so a scenario can
   * carry on from a real connection rather than a fabricated row.
   */
  async function connectAStore(site = nextSite()): Promise<{
    storeId: string;
    token: string;
    site: string;
  }> {
    const verifier = digest();
    const state = digest();

    const initiated = await request(app.getHttpServer())
      .post('/v1/connect/initiate')
      .send({
        site_url: site,
        callback: `${site}/wp-admin/admin.php?page=optionia-connect`,
        state,
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        plugin_version: '1.0.0',
      });

    expect(initiated.status).toBe(200);

    const requestId = new URL(initiated.body.data.authorize_url).searchParams.get('request');

    const approved = await request(app.getHttpServer())
      .post('/v1/connect/authorize')
      .set('Authorization', `Bearer ${merchant}`)
      .send({ request: requestId, state });

    expect(approved.status).toBe(200);

    const code = new URL(approved.body.data.redirect_url).searchParams.get('code') ?? '';

    const exchanged = await request(app.getHttpServer())
      .post('/v1/connect/exchange')
      .send({ code, verifier, site_url: site });

    expect(exchanged.status).toBe(200);

    return { storeId: exchanged.body.data.store_id, token: exchanged.body.data.token, site };
  }

  const heartbeat = (token: string, body: object = {}, site?: string): request.Test => {
    const call = request(app.getHttpServer())
      .post('/v1/store/heartbeat')
      .set('Authorization', `Bearer ${token}`);

    return (site ? call.set('X-Optionia-Site', site) : call).send(body);
  };

  /**
   * **A merchant can connect a store**, through the real endpoints in order.
   *
   * The cloud half of "connect in under 60 seconds": the flow completes without
   * a manual step between `initiate` and a working credential.
   */
  describe('a store connects', () => {
    it('reaches CONNECTED with a working credential', async () => {
      const store = await connectAStore();

      const [row] = await dataSource.query(
        `SELECT status, connectedAt, tenantId FROM stores WHERE id = ?`,
        [store.storeId],
      );

      expect(row.status).toBe(StoreStatus.CONNECTED);
      expect(row.connectedAt).not.toBeNull();
      expect(row.tenantId).toBe(tenantId);

      // The credential works immediately — no second step.
      expect((await heartbeat(store.token)).status).toBe(200);
    });

    /** Every transition of that store is in the trail (M8.1b's acceptance). */
    it('logs every transition it passed through', async () => {
      const store = await connectAStore();

      const rows = await dataSource.query(
        `SELECT action FROM audit_logs WHERE resourceId = ? ORDER BY createdAt ASC`,
        [store.storeId],
      );

      const actions = rows.map((row: { action: string }) => row.action);

      expect(actions).toContain('store.connect_authorized');
      expect(actions).toContain('store.connected');
    });
  });

  /**
   * **Codes are single-use, short-lived and bound** — M8.1's acceptance in full.
   *
   * Each binding is driven against a *real* code from a real handshake, not a
   * fabricated row, so the test proves the binding as the plugin experiences it.
   */
  describe('the authorization code', () => {
    /** A code that has already bought a credential cannot buy a second. */
    it('is spent by the exchange that used it', async () => {
      const site = nextSite();
      const verifier = digest();
      const state = digest();

      const initiated = await request(app.getHttpServer())
        .post('/v1/connect/initiate')
        .send({
          site_url: site,
          callback: `${site}/cb`,
          state,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
        });

      const requestId = new URL(initiated.body.data.authorize_url).searchParams.get('request');
      const approved = await request(app.getHttpServer())
        .post('/v1/connect/authorize')
        .set('Authorization', `Bearer ${merchant}`)
        .send({ request: requestId, state });

      const code = new URL(approved.body.data.redirect_url).searchParams.get('code') ?? '';

      expect(
        (await request(app.getHttpServer())
          .post('/v1/connect/exchange')
          .send({ code, verifier, site_url: site })).status,
      ).toBe(200);

      // The second attempt buys nothing.
      expect(
        (await request(app.getHttpServer())
          .post('/v1/connect/exchange')
          .send({ code, verifier, site_url: site })).status,
      ).toBe(401);
    });

    /** ≤ 5 minutes, and an expired code is refused however valid it looks. */
    it('expires, and an expired one is refused', async () => {
      const site = nextSite();
      const verifier = digest();
      const state = digest();

      const initiated = await request(app.getHttpServer())
        .post('/v1/connect/initiate')
        .send({
          site_url: site,
          callback: `${site}/cb`,
          state,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
        });

      const requestId = new URL(initiated.body.data.authorize_url).searchParams.get('request');
      const approved = await request(app.getHttpServer())
        .post('/v1/connect/authorize')
        .set('Authorization', `Bearer ${merchant}`)
        .send({ request: requestId, state });

      const code = new URL(approved.body.data.redirect_url).searchParams.get('code') ?? '';

      // The lifetime is real; the clock is what a test can move.
      const [row] = await dataSource.query(
        `SELECT codeExpiresAt, approvedAt FROM store_connection_codes WHERE id = ?`,
        [requestId],
      );

      const lifetimeMs =
        new Date(row.codeExpiresAt).getTime() - new Date(row.approvedAt).getTime();

      expect(lifetimeMs).toBeLessThanOrEqual(5 * 60_000);

      await dataSource.query(
        `UPDATE store_connection_codes SET codeExpiresAt = NOW(3) - INTERVAL 1 SECOND
          WHERE id = ?`,
        [requestId],
      );

      expect(
        (await request(app.getHttpServer())
          .post('/v1/connect/exchange')
          .send({ code, verifier, site_url: site })).status,
      ).toBe(401);
    });

    /** Bound to `site_url`: a code issued for one shop is useless at another. */
    it('is bound to the site that requested it', async () => {
      const site = nextSite();
      const verifier = digest();
      const state = digest();

      const initiated = await request(app.getHttpServer())
        .post('/v1/connect/initiate')
        .send({
          site_url: site,
          callback: `${site}/cb`,
          state,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
        });

      const requestId = new URL(initiated.body.data.authorize_url).searchParams.get('request');
      const approved = await request(app.getHttpServer())
        .post('/v1/connect/authorize')
        .set('Authorization', `Bearer ${merchant}`)
        .send({ request: requestId, state });

      const code = new URL(approved.body.data.redirect_url).searchParams.get('code') ?? '';

      expect(
        (await request(app.getHttpServer())
          .post('/v1/connect/exchange')
          .send({ code, verifier, site_url: nextSite() })).status,
      ).toBe(401);
    });

    /** Bound to `state`: an approval with the wrong one mints nothing. */
    it('is bound to the state the plugin generated', async () => {
      const site = nextSite();
      const initiated = await request(app.getHttpServer())
        .post('/v1/connect/initiate')
        .send({
          site_url: site,
          callback: `${site}/cb`,
          state: digest(),
          challenge: digest(),
        });

      const requestId = new URL(initiated.body.data.authorize_url).searchParams.get('request');

      expect(
        (await request(app.getHttpServer())
          .post('/v1/connect/authorize')
          .set('Authorization', `Bearer ${merchant}`)
          .send({ request: requestId, state: digest() })).status,
      ).toBe(401);
    });
  });

  /**
   * **Rotation and revocation work**, and the old credential dies at once —
   * M8.6's requirement, which is why a store token is opaque rather than a JWT.
   */
  describe('rotation and revocation', () => {
    it('replaces a credential, killing the old one on the next request', async () => {
      const store = await connectAStore();

      expect((await heartbeat(store.token)).status).toBe(200);

      const rotated = await request(app.getHttpServer())
        .post(`/v1/stores/${store.storeId}/rotate-credential`)
        .set('Authorization', `Bearer ${merchant}`)
        .send({ reason: 'suspected disclosure' });

      expect(rotated.status).toBe(200);

      // No grace period: the old one is dead and the new one works.
      expect((await heartbeat(store.token)).status).toBe(401);
      expect((await heartbeat(rotated.body.data.token)).status).toBe(200);
    });

    it('disconnects a store, killing every credential', async () => {
      const store = await connectAStore();

      const disconnected = await request(app.getHttpServer())
        .post(`/v1/stores/${store.storeId}/disconnect`)
        .set('Authorization', `Bearer ${merchant}`)
        .send({});

      expect(disconnected.status).toBe(200);
      expect((await heartbeat(store.token)).status).toBe(401);
    });

    /**
     * **The cloud half of "revocation degrades gracefully".**
     *
     * The plugin's half — serving its cached copy after a `401` — lives in the
     * plugin. What the cloud must guarantee is that it *destroys nothing the
     * storefront needs*, so there is still something to serve when the merchant
     * reconnects.
     */
    it('destroys no configuration when a credential is revoked', async () => {
      const store = await connectAStore();

      /**
       * Give the store a published configuration first.
       *
       * A freshly connected store has `configVersion = 0`, so comparing before
       * and after would be `0 === 0` — a test that passes whatever disconnect
       * does to the column. Verified by mutation: wiping `configVersion` on
       * disconnect broke nothing until this line existed.
       */
      await dataSource.query(`UPDATE stores SET configVersion = 42 WHERE id = ?`, [
        store.storeId,
      ]);

      const before = await dataSource.query(
        `SELECT configVersion, storeUrl FROM stores WHERE id = ?`,
        [store.storeId],
      );

      expect(Number(before[0].configVersion)).toBe(42);

      await request(app.getHttpServer())
        .post(`/v1/stores/${store.storeId}/disconnect`)
        .set('Authorization', `Bearer ${merchant}`)
        .send({});

      const after = await dataSource.query(
        `SELECT configVersion, storeUrl FROM stores WHERE id = ?`,
        [store.storeId],
      );

      // The store row survives, with its configuration pointer intact.
      expect(after).toHaveLength(1);
      expect(after[0].configVersion).toBe(before[0].configVersion);
      expect(after[0].storeUrl).toBe(before[0].storeUrl);
    });
  });

  /** **The heartbeat populates store telemetry** — M8.5's whole purpose. */
  describe('the heartbeat', () => {
    it('records what the install is running, and when it last checked in', async () => {
      const store = await connectAStore();

      await heartbeat(store.token, {
        plugin_version: '1.4.2',
        wp_version: '6.5.2',
        wc_version: '8.7.0',
        php_version: '8.2.15',
        connection_state: StoreStatus.CONNECTED,
      });

      const [row] = await dataSource.query(
        `SELECT pluginVersion, wpVersion, wcVersion, phpVersion, lastSeenAt
           FROM stores WHERE id = ?`,
        [store.storeId],
      );

      expect(row.pluginVersion).toBe('1.4.2');
      expect(row.wpVersion).toBe('6.5.2');
      expect(row.wcVersion).toBe('8.7.0');
      expect(row.phpVersion).toBe('8.2.15');
      expect(row.lastSeenAt).not.toBeNull();
    });
  });

  /**
   * **A cloned site cannot silently reuse the original's credential** — M8.1b's
   * acceptance, and the scenario the whole phase is shaped around.
   */
  describe('a cloned site', () => {
    it('is refused, while the original keeps working and the clone is recorded', async () => {
      const store = await connectAStore();

      // The clone: same credential, its own address.
      const refused = await heartbeat(store.token, {}, 'https://ph8-clone.example.com');

      expect(refused.status).toBe(403);

      // The original is untouched — refusing a clone must not disconnect a shop.
      const [row] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [
        store.storeId,
      ]);

      expect(row.status).toBe(StoreStatus.CONNECTED);
      expect((await heartbeat(store.token, {}, store.site)).status).toBe(200);

      // And it is not silent: the evidence names both addresses.
      const [evidence] = await dataSource.query(
        `SELECT changes FROM audit_logs
          WHERE resourceId = ? AND action = 'store.site_mismatch' LIMIT 1`,
        [store.storeId],
      );

      expect(evidence).toBeDefined();

      const changes =
        typeof evidence.changes === 'string' ? JSON.parse(evidence.changes) : evidence.changes;

      expect(changes.presented).toBe('https://ph8-clone.example.com');
      expect(changes.expected).toBe(store.site);
    });
  });
});
