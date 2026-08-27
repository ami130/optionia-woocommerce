import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Disconnect and credential rotation (M8.6, `[8g]`).
 *
 * The first routes a merchant drives against an existing store, and both are
 * destructive: one revokes every credential, the other replaces one.
 */
describe('store ownership (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  let owner = '';
  let outsider = '';
  let tenantId = '';

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('own8g');
    dataSource = app.get(DataSource);

    await harness.cleanup();

    owner = await harness.tenant('a');
    tenantId = await harness.tenantIdOf('a');
    outsider = await harness.tenant('b');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store with one live credential — the normal starting point. */
  async function connectedStore(which = 'a'): Promise<{ id: string; token: string }> {
    const id = await harness.store(which);
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
      StoreStatus.CONNECTED,
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

  const post = (path: string, token: string, body: object = {}): request.Test =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const liveCredentials = async (storeId: string): Promise<number> => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM store_credentials WHERE storeId = ? AND revokedAt IS NULL`,
      [storeId],
    );

    return Number(row.n);
  };

  describe('disconnect', () => {
    it('revokes every live credential and moves the store to DISCONNECTED', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/disconnect`, owner);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(StoreStatus.DISCONNECTED);
      expect(response.body.data.credentials_revoked).toBe(1);
      expect(await liveCredentials(store.id)).toBe(0);

      /**
       * The **persisted** state, not the response's.
       *
       * `status` in the body is a constant the handler returns, so asserting it
       * alone proves the constant and nothing else — verified by mutation:
       * transitioning to `CONNECTING` instead of `DISCONNECTED` broke no test
       * until this line existed.
       */
      const [row] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [store.id]);

      expect(row.status).toBe(StoreStatus.DISCONNECTED);
    });

    /**
     * The credential must stop working on the **next** request, which is the
     * whole reason it is an opaque token rather than a JWT (M8.6).
     */
    it('kills the credential immediately', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/disconnect`, owner);

      const [row] = await dataSource.query(
        `SELECT revokedAt FROM store_credentials WHERE tokenHash = ?`,
        [createHash('sha256').update(store.token).digest('hex')],
      );

      expect(row.revokedAt).not.toBeNull();
    });

    /** A merchant clicking twice is not an error (M8.6). */
    it('is idempotent, reporting nothing revoked the second time', async () => {
      const store = await connectedStore();

      expect((await post(`/stores/${store.id}/disconnect`, owner)).body.data.credentials_revoked)
        .toBe(1);

      const second = await post(`/stores/${store.id}/disconnect`, owner);

      expect(second.status).toBe(200);
      expect(second.body.data.credentials_revoked).toBe(0);
      expect(second.body.data.status).toBe(StoreStatus.DISCONNECTED);

      // And it is still disconnected in the database, not merely reported so.
      const [row] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [store.id]);

      expect(row.status).toBe(StoreStatus.DISCONNECTED);
    });

    it('revokes several credentials at once', async () => {
      const store = await connectedStore();
      const extra = generateStoreToken();

      await dataSource.query(
        `INSERT INTO store_credentials
           (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
         VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
        [store.id, extra.hash, extra.prefix],
      );

      const response = await post(`/stores/${store.id}/disconnect`, owner);

      expect(response.body.data.credentials_revoked).toBe(2);
      expect(await liveCredentials(store.id)).toBe(0);
    });

    /**
     * ADR-010: another tenant's store is a **404, not a 403**. A 403 confirms
     * the store exists, which is what an enumerating caller wants to learn.
     */
    it('answers 404 for another tenant’s store', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/disconnect`, outsider);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      // And it changed nothing.
      expect(await liveCredentials(store.id)).toBe(1);
    });

    it('answers 404 for a store that does not exist', async () => {
      const response = await post(
        '/stores/01a0432e-6d22-716e-80a2-643aea24dfb2/disconnect',
        owner,
      );

      expect(response.status).toBe(404);
    });

    it('records the disconnection', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/disconnect`, owner);

      const [row] = await dataSource.query(
        `SELECT action, tenantId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.disconnected' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();
      expect(row.tenantId).toBe(tenantId);
    });
  });

  describe('rotate-credential', () => {
    it('returns a new credential carrying the marker', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/rotate-credential`, owner);

      expect(response.status).toBe(200);
      expect(response.body.data.token).toMatch(/^osk_live_/);
      expect(response.body.data.rotated_at).toBeTruthy();
    });

    /**
     * `prefix` is the eight characters **after** the marker. The contract's
     * example once showed `"osk_live"`, which is the same for every credential
     * and identifies nothing — the opposite of what the column is for.
     */
    it('returns a prefix that discriminates, not the marker', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/rotate-credential`, owner);

      expect(response.body.data.prefix).not.toBe('osk_live');
      expect(response.body.data.token).toContain(response.body.data.prefix);
    });

    /**
     * No grace period (M8.6). A rotation asked for because a token leaked must
     * take effect at once; a window in which both work is a window in which the
     * leaked one still works.
     */
    it('revokes the old credential immediately, leaving exactly one live', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/rotate-credential`, owner);

      const [old] = await dataSource.query(
        `SELECT revokedAt FROM store_credentials WHERE tokenHash = ?`,
        [createHash('sha256').update(store.token).digest('hex')],
      );

      expect(old.revokedAt).not.toBeNull();
      expect(await liveCredentials(store.id)).toBe(1);
    });

    it('leaves the store connected', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/rotate-credential`, owner);

      const [row] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [store.id]);

      expect(row.status).toBe(StoreStatus.CONNECTED);
    });

    /** A disconnected store has no credential worth replacing. */
    it('answers 409 for a store that is not connected', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/disconnect`, owner);

      const response = await post(`/stores/${store.id}/rotate-credential`, owner);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('answers 404 for another tenant’s store', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/rotate-credential`, outsider);

      expect(response.status).toBe(404);
      // The old credential is untouched.
      expect(await liveCredentials(store.id)).toBe(1);
    });

    it('accepts an empty body', async () => {
      const store = await connectedStore();

      expect((await post(`/stores/${store.id}/rotate-credential`, owner)).status).toBe(200);
    });

    it('refuses an unknown field', async () => {
      const store = await connectedStore();
      const response = await post(`/stores/${store.id}/rotate-credential`, owner, {
        unexpected: 'x',
      });

      expect(response.status).toBe(400);
    });

    it('records the rotation with its reason', async () => {
      const store = await connectedStore();

      await post(`/stores/${store.id}/rotate-credential`, owner, {
        reason: 'suspected disclosure',
      });

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs
          WHERE resourceId = ? AND action = 'store.credential_rotated' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();

      const changes =
        typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;

      expect(changes.reason).toBe('suspected disclosure');
    });
  });
});
