import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The store heartbeat (M8.5, `[8h]`).
 *
 * The store realm's first route, and the endpoint support depends on: it reveals
 * stale installs and dead connections before a merchant reports them.
 */
describe('store heartbeat (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;
  let tenantId = '';

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('hb8h');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await harness.tenant('a');
    tenantId = await harness.tenantIdOf('a');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store with a live credential — a plugin that can ping. */
  async function connected(
    status: StoreStatus = StoreStatus.CONNECTED,
    configVersion = 0,
  ): Promise<{ id: string; token: string }> {
    const id = await harness.store('a');
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ?, configVersion = ? WHERE id = ?`, [
      status,
      configVersion,
      id,
    ]);
    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [id, credential.hash, credential.prefix],
    );

    return { id, token: credential.plaintext };
  }

  const ping = (token: string, body: object = {}): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const storeRow = async (id: string): Promise<Record<string, unknown>> => {
    const [row] = await dataSource.query(`SELECT * FROM stores WHERE id = ?`, [id]);

    return row;
  };

  const mismatches = async (storeId: string): Promise<number> => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE resourceId = ? AND action = 'store.state_mismatch'`,
      [storeId],
    );

    return Number(row.n);
  };

  describe('telemetry', () => {
    /**
     * The persisted row, not the response.
     *
     * The response is entirely derived values, so asserting it proves the
     * handler returns what it was given. `stores` is where the endpoint's only
     * real effect lands.
     */
    it('records what the install is running', async () => {
      const store = await connected();

      const response = await ping(store.token, {
        plugin_version: '1.2.3',
        wp_version: '6.5.2',
        wc_version: '8.7.0',
        php_version: '8.2.15',
        connection_state: StoreStatus.CONNECTED,
        config_version: 0,
        cache_age_seconds: 3600,
      });

      expect(response.status).toBe(200);

      const row = await storeRow(store.id);

      expect(row.pluginVersion).toBe('1.2.3');
      expect(row.wpVersion).toBe('6.5.2');
      expect(row.wcVersion).toBe('8.7.0');
      expect(row.phpVersion).toBe('8.2.15');
    });

    /** The column is indexed precisely so stale installs are visible. */
    it('stamps lastSeenAt on every ping', async () => {
      const store = await connected();

      expect((await storeRow(store.id)).lastSeenAt).toBeNull();

      await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect((await storeRow(store.id)).lastSeenAt).not.toBeNull();
    });

    /**
     * A ping that omits a field must not erase what was already known — a
     * plugin that cannot read `WC_VERSION` should not blank the last value
     * support saw.
     */
    it('leaves a known version untouched when a ping omits it', async () => {
      const store = await connected();

      await ping(store.token, { wc_version: '8.7.0' });
      await ping(store.token, { plugin_version: '1.2.3' });

      const row = await storeRow(store.id);

      expect(row.wcVersion).toBe('8.7.0');
      expect(row.pluginVersion).toBe('1.2.3');
    });

    it('accepts an empty body', async () => {
      const store = await connected();

      expect((await ping(store.token)).status).toBe(200);
      expect((await storeRow(store.id)).lastSeenAt).not.toBeNull();
    });
  });

  describe('the response', () => {
    it('answers the cloud’s config version, so a plugin learns it is behind', async () => {
      const store = await connected(StoreStatus.CONNECTED, 43);
      const response = await ping(store.token, { config_version: 42 });

      expect(response.body.data.config_version).toBe(43);
    });

    /** The cloud's view, never the plugin's echoed back. */
    it('answers the cloud’s status, not the plugin’s claim', async () => {
      const store = await connected(StoreStatus.ERROR);
      const response = await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect(response.body.data.status).toBe(StoreStatus.ERROR);
    });
  });

  /**
   * M8.1b: the two views can disagree, and guessing which is right is the
   * largest source of support tickets in this category of product.
   */
  describe('reconciliation', () => {
    it('records a mismatch, carrying both views', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.ERROR });

      const [row] = await dataSource.query(
        `SELECT changes, tenantId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.state_mismatch' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();
      expect(row.tenantId).toBe(tenantId);

      const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;

      expect(changes.pluginState).toBe(StoreStatus.ERROR);
      expect(changes.cloudState).toBe(StoreStatus.CONNECTED);
    });

    /**
     * **The cloud never adopts the plugin's claim.** A cloned staging site
     * reports on a production store it is impersonating; believing it would let
     * a clone degrade the original.
     */
    it('never writes the plugin’s claim to stores.status', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.DISCONNECTED });

      expect((await storeRow(store.id)).status).toBe(StoreStatus.CONNECTED);
    });

    it('records nothing when the views agree', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect(await mismatches(store.id)).toBe(0);
    });

    /** A silent heartbeat is not a disagreement. */
    it('records nothing when the plugin sends no view', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { plugin_version: '1.0.0' });

      expect(await mismatches(store.id)).toBe(0);
    });
  });

  describe('the realm', () => {
    it('refuses a request with no credential', async () => {
      const response = await request(app.getHttpServer()).post('/v1/store/heartbeat').send({});

      expect(response.status).toBe(401);
    });

    it('refuses an unknown credential', async () => {
      expect((await ping(generateStoreToken().plaintext)).status).toBe(401);
    });

    /** M8.6: revocation takes effect on the very next request. */
    it('refuses a revoked credential', async () => {
      const store = await connected();

      expect((await ping(store.token)).status).toBe(200);

      await dataSource.query(`UPDATE store_credentials SET revokedAt = NOW(3) WHERE storeId = ?`, [
        store.id,
      ]);

      expect((await ping(store.token)).status).toBe(401);
    });

    /** A merchant's JWT is a different realm entirely. */
    it('refuses a tenant token', async () => {
      const merchant = await harness.tenant('b');

      expect((await ping(merchant)).status).toBe(401);
    });
  });

  describe('validation', () => {
    it('refuses an unknown connection state', async () => {
      const store = await connected();

      expect((await ping(store.token, { connection_state: 'exploded' })).status).toBe(400);
    });

    it('refuses a negative config version', async () => {
      const store = await connected();

      expect((await ping(store.token, { config_version: -1 })).status).toBe(400);
    });

    it('refuses an over-long version string', async () => {
      const store = await connected();

      expect((await ping(store.token, { plugin_version: 'x'.repeat(21) })).status).toBe(400);
    });

    it('refuses an unknown field', async () => {
      const store = await connected();

      expect((await ping(store.token, { unexpected: 'x' })).status).toBe(400);
    });

    /**
     * All five states are accepted, including ones a healthy plugin would never
     * report — narrowing the field would reject the anomalous report at
     * validation and lose the signal reconciliation exists to capture.
     */
    it('accepts every declared state, and reconciles the odd ones', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      for (const state of Object.values(StoreStatus)) {
        expect((await ping(store.token, { connection_state: state })).status).toBe(200);
      }

      // Four of the five disagree with CONNECTED.
      expect(await mismatches(store.id)).toBe(Object.values(StoreStatus).length - 1);
    });
  });
});
