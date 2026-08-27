import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

  /**
   * A member **of the owner's tenant**, holding `role`.
   *
   * Registration makes every user the owner of a tenant of their own, so simply
   * demoting them tests the wrong thing: they would be a viewer of *their* empty
   * workspace, and every request against this suite's store would be refused for
   * belonging to another tenant rather than for lacking a capability.
   *
   * Caught while writing these: the admin case returned `404`, which is what a
   * cross-tenant request answers (ADR-010). The viewer and editor cases had
   * "passed" — but a `403` from `CapabilityGuard` and a refusal for the wrong
   * tenant are indistinguishable from outside, so they proved less than they
   * appeared to.
   *
   * Adding a membership row puts the caller inside the owner's tenant, leaving
   * **role as the only variable**.
   */
  async function memberWithRole(which: string, role: string): Promise<string> {
    const email = `own8g-${which}@example.com`;

    await harness.tenant(which);

    const [user] = await dataSource.query(`SELECT id FROM users WHERE email = ?`, [email]);

    /**
     * Revoke their own membership first, then join the owner's tenant.
     *
     * `primaryMembership` picks the **oldest** live membership, so a user who
     * still owns their own tenant is issued a token naming it however many other
     * tenants they belong to. Revoking it makes the owner's tenant the only
     * candidate — and the token has to be minted *after* both writes, because
     * `tid` is fixed when it is signed.
     */
    await dataSource.query(`UPDATE tenant_members SET revokedAt = NOW(3) WHERE userId = ?`, [
      user.id,
    ]);

    await dataSource.query(
      `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, ?, NOW(3), NOW(3), NOW(3))`,
      [tenantId, user.id, role],
    );

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: 'a-sufficiently-long-password' });

    if (login.status !== 200) {
      throw new Error(`login failed for ${email}: ${login.status}`);
    }

    return login.body.data.accessToken as string;
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

    /**
     * Defence in depth for the `[8f]` scenario.
     *
     * The state guard already refuses to move a `DISCONNECTED` store back to
     * `CONNECTED`, so an unspent code cannot resurrect it. Spending the code as
     * well means no artefact survives that *looks* redeemable — the merchant's
     * disconnect is a clear statement that the handshake is over.
     */
    it('spends any pending connection code', async () => {
      const store = await connectedStore();

      await dataSource.query(
        `INSERT INTO store_connection_codes
           (id, createdAt, updatedAt, siteUrl, callback, stateHash, challenge,
            requestExpiresAt, storeId, codeHash, codeExpiresAt, approvedAt)
         VALUES (UUID(), NOW(3), NOW(3), 'https://own8g-pending.example.com',
                 'https://own8g-pending.example.com/cb', REPEAT('a', 64), REPEAT('b', 43),
                 NOW(3) + INTERVAL 30 MINUTE, ?, REPEAT('c', 64),
                 NOW(3) + INTERVAL 5 MINUTE, NOW(3))`,
        [store.id],
      );

      await post(`/stores/${store.id}/disconnect`, owner);

      const [row] = await dataSource.query(
        `SELECT redeemedAt FROM store_connection_codes WHERE storeId = ?`,
        [store.id],
      );

      expect(row.redeemedAt).not.toBeNull();
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

  /**
   * Both routes are destructive ownership acts, and the permission matrix gives
   * `stores:connect` and `stores:rotate_credential` to owner and admin only.
   *
   * Untested until now, and a mutation proved the gap: swapping **both** routes
   * to `option_sets:view` — which `viewer` holds — passed all nineteen tests. A
   * viewer could have disconnected a store and rotated its credential with
   * nothing failing.
   */
  describe('capabilities', () => {
    it('refuses a viewer on both routes', async () => {
      const viewer = await memberWithRole('viewer', 'viewer');
      const store = await connectedStore();

      expect((await post(`/stores/${store.id}/disconnect`, viewer)).status).toBe(403);
      expect((await post(`/stores/${store.id}/rotate-credential`, viewer)).status).toBe(403);

      // And nothing was touched on the way to being refused.
      expect(await liveCredentials(store.id)).toBe(1);
    });

    /** An editor can author options and still not own the connection. */
    it('refuses an editor on both routes', async () => {
      const editor = await memberWithRole('editor', 'editor');
      const store = await connectedStore();

      expect((await post(`/stores/${store.id}/disconnect`, editor)).status).toBe(403);
      expect((await post(`/stores/${store.id}/rotate-credential`, editor)).status).toBe(403);
    });

    it('admits an admin on both routes', async () => {
      const admin = await memberWithRole('admin', 'admin');
      const store = await connectedStore();

      expect((await post(`/stores/${store.id}/rotate-credential`, admin)).status).toBe(200);
      expect((await post(`/stores/${store.id}/disconnect`, admin)).status).toBe(200);
    });

    /**
     * The two routes must declare **different** capabilities.
     *
     * No role today holds one without the other — owner and admin hold both,
     * everyone else neither — so no HTTP test can separate them. Asserting the
     * declarations directly is what catches a route being pointed at the wrong
     * capability, which is the mutation the tests above cannot see.
     */
    it('declares a distinct capability for each route', () => {
      const source = readFileSync('src/stores/stores.controller.ts', 'utf8');

      expect(source).toContain('Capability.STORES_CONNECT');
      expect(source).toContain('Capability.STORES_ROTATE_CREDENTIAL');
      // Neither route may fall back to a capability a viewer holds.
      expect(source).not.toContain('Capability.OPTION_SETS_VIEW');
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

    /**
     * An erroring store still holds a live credential, and a merchant who
     * suspects that error *is* a compromised token is who rotation exists for.
     *
     * An earlier guard of `!== CONNECTED` refused them, making the security
     * feature unavailable in the state that most suggests it is needed.
     */
    it('rotates a store in ERROR, which still holds a live credential', async () => {
      const store = await connectedStore();

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.ERROR,
        store.id,
      ]);

      const response = await post(`/stores/${store.id}/rotate-credential`, owner);

      expect(response.status).toBe(200);
      expect(response.body.data.token).toMatch(/^osk_live_/);
      expect(await liveCredentials(store.id)).toBe(1);

      // And the old one is dead, exactly as for a connected store.
      const [old] = await dataSource.query(
        `SELECT revokedAt FROM store_credentials WHERE tokenHash = ?`,
        [createHash('sha256').update(store.token).digest('hex')],
      );

      expect(old.revokedAt).not.toBeNull();
    });

    /** A store still handshaking has no credential yet. */
    it('answers 409 for a store that is still CONNECTING', async () => {
      const store = await connectedStore();

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.CONNECTING,
        store.id,
      ]);

      expect((await post(`/stores/${store.id}/rotate-credential`, owner)).status).toBe(409);
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
