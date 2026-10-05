import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';
import { MAX_RENDER_MEGAPIXELS } from '../src/common/render/render-bounds';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Render requests (M26e.4).
 *
 * 🔴 **Two properties carry this endpoint**, and they are the same two the
 * order route is built around: **idempotency**, because the plugin retries
 * whenever a response is sent but never received, and **store isolation**,
 * because a render is work billed to a tenant and artwork belonging to their
 * customer.
 *
 * ⚠️ **M26e.4 states the first as a requirement**: *"idempotent (a retry must
 * not produce a second file)"*. A second row would mean a second render, a
 * second file, and a second charge against the merchant's storage quota.
 */
describe('render jobs (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('rnd264');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await harness.tenant('a');
    await harness.tenant('b');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store with a live credential — a plugin that can ask. */
  async function connected(tenant: 'a' | 'b' = 'a'): Promise<{ id: string; token: string }> {
    const id = await harness.store(tenant);
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

  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    line_ref: `wc-line-${Math.random().toString(36).slice(2, 10)}`,
    scene: { width: 800, height: 800, groups: [] },
    width: 800,
    height: 800,
    ...overrides,
  });

  const ask = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/renders')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const jobsFor = async (storeId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(`SELECT * FROM render_jobs WHERE storeId = ?`, [storeId]);

  describe('accepting a render', () => {
    it('records the request and reports it as preparing', async () => {
      const store = await connected();
      const body = payload();

      const response = await ask(store.token, body).expect(200);

      expect(response.body.data.status).toBe('preparing');
      expect(response.body.data.duplicate).toBe(false);
      expect(response.body.data.fileUrl).toBeNull();

      const [job] = await jobsFor(store.id);

      expect(job.lineRef).toBe(body.line_ref);
      expect(job.processedAt).toBeNull();
      expect(job.attempts).toBe(0);
    });

    /*
     * 🔴 **The scene is stored, not re-derived.** A design the merchant edits
     * tomorrow must not change the file a customer bought today — the same
     * reason `order_selections` snapshots its labels.
     */
    it('snapshots the scene it was given', async () => {
      const store = await connected();
      const scene = { width: 400, height: 600, groups: [{ key: 'g', images: [] }] };

      await ask(store.token, payload({ scene })).expect(200);

      const [job] = await jobsFor(store.id);
      const stored = typeof job.scene === 'string' ? JSON.parse(job.scene as string) : job.scene;

      expect(stored).toEqual(scene);
    });
  });

  // --- Idempotency ---------------------------------------------------------

  describe('a retry', () => {
    /*
     * 🔴 **M26e.4's own requirement.** The plugin retries whenever a response
     * is sent but never received; a second row would mean a second render, a
     * second file, and a second charge against the storage quota.
     */
    it('does not produce a second job', async () => {
      const store = await connected();
      const body = payload();

      await ask(store.token, body).expect(200);
      const second = await ask(store.token, body).expect(200);

      expect(second.body.data.duplicate).toBe(true);
      expect(await jobsFor(store.id)).toHaveLength(1);
    });

    it('returns the same job id both times', async () => {
      const store = await connected();
      const body = payload();

      const first = await ask(store.token, body).expect(200);
      const second = await ask(store.token, body).expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
    });

    /*
     * ⚠️ **A retry must not RESTART a finished render.** Overwriting the scene
     * on a duplicate would discard a completed file and redo the work — which
     * is the opposite of what idempotency is for.
     */
    it('does not disturb a job that has already rendered', async () => {
      const store = await connected();
      const body = payload();

      await ask(store.token, body).expect(200);

      await dataSource.query(
        `UPDATE render_jobs SET processedAt = NOW(3), fileUrl = ? WHERE storeId = ?`,
        ['https://store.test/wp-content/uploads/print.png', store.id],
      );

      const retry = await ask(store.token, payload({ line_ref: body.line_ref })).expect(200);

      expect(retry.body.data.status).toBe('ready');
      expect(retry.body.data.fileUrl).toBe('https://store.test/wp-content/uploads/print.png');

      const [job] = await jobsFor(store.id);

      expect(job.processedAt).not.toBeNull();
    });

    /* 📌 A different line is a different job, not a duplicate. */
    it('accepts a second line as its own job', async () => {
      const store = await connected();

      await ask(store.token, payload()).expect(200);
      await ask(store.token, payload()).expect(200);

      expect(await jobsFor(store.id)).toHaveLength(2);
    });

    /*
     * 🔴 **The unique key is per STORE, not global.** Two shops can name a cart
     * line identically — WooCommerce hashes are not globally unique — and one
     * store's retry must never collide with another's first request.
     */
    it('does not collide across stores on the same line ref', async () => {
      const first = await connected('a');
      const second = await connected('b');
      const body = payload();

      await ask(first.token, body).expect(200);
      await ask(second.token, body).expect(200);

      expect(await jobsFor(first.id)).toHaveLength(1);
      expect(await jobsFor(second.id)).toHaveLength(1);
    });
  });

  // --- Bounds --------------------------------------------------------------

  describe('refusing what cannot be rendered', () => {
    /*
     * 🔴 **The OOM kill, refused at the door.** 50000×50000 was measured
     * rendering for 46 seconds and ~10 GB before the kernel killed the
     * process — and a kernel kill reports nothing. Refusing at acceptance
     * means the store learns immediately rather than the job dying silently.
     */
    it('refuses a canvas beyond the megapixel ceiling', async () => {
      const store = await connected();
      const edge = Math.ceil(Math.sqrt(MAX_RENDER_MEGAPIXELS * 1_000_000)) + 1_000;

      await ask(store.token, payload({ width: edge, height: edge })).expect(400);

      expect(await jobsFor(store.id)).toHaveLength(0);
    });

    it.each([
      ['zero', 0],
      ['negative', -10],
    ])('refuses a %s dimension', async (_name, value) => {
      const store = await connected();

      await ask(store.token, payload({ width: value })).expect(400);
    });

    it('refuses a request with no line reference', async () => {
      const store = await connected();

      await ask(store.token, payload({ line_ref: '' })).expect(400);
    });
  });

  // --- Collection ----------------------------------------------------------

  describe('collecting a rendered file', () => {
    /** Accept a job and put bytes in its buffer, as the worker would. */
    async function rendered(token: string, storeId: string): Promise<string> {
      const body = payload();
      const response = await ask(token, body).expect(200);

      await dataSource.query(
        `UPDATE render_jobs SET processedAt = NOW(3), png = ?, collectBy = ? WHERE storeId = ?`,
        [Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), new Date(Date.now() + 3_600_000), storeId],
      );

      return response.body.data.id as string;
    }

    const fetch = (token: string, id: string): request.Test =>
      request(app.getHttpServer())
        .get(`/v1/store/renders/${id}/file`)
        .set('Authorization', `Bearer ${token}`);

    const confirm = (token: string, id: string, body: object): request.Test =>
      request(app.getHttpServer())
        .post(`/v1/store/renders/${id}/collected`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    it('serves the bytes the worker buffered', async () => {
      const store = await connected();
      const id = await rendered(store.token, store.id);

      const response = await fetch(store.token, id).expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect(response.body.length).toBe(7);
    });

    /*
     * 🔴 **A render is a customer's artwork.** Serving one store's file to
     * another is the same class of defect as cross-tenant revenue.
     */
    it('refuses another store’s file', async () => {
      const mine = await connected('a');
      const theirs = await connected('b');
      const id = await rendered(mine.token, mine.id);

      await fetch(theirs.token, id).expect(404);
    });

    it('refuses an unauthenticated fetch', async () => {
      const store = await connected();
      const id = await rendered(store.token, store.id);

      await request(app.getHttpServer())
        .get(`/v1/store/renders/${id}/file`)
        .expect(401);
    });

    it('404s a job that has not rendered yet', async () => {
      const store = await connected();
      const response = await ask(store.token, payload()).expect(200);

      await fetch(store.token, response.body.data.id).expect(404);
    });

    /*
     * 🔴 **Confirming is what ends the transfer**, and what makes `ready` mean
     * something: the merchant holds the file, and the cloud does not.
     */
    it('records the file url and releases the buffer', async () => {
      const store = await connected();
      const id = await rendered(store.token, store.id);
      const url = 'https://store.test/wp-content/uploads/print.png';

      await confirm(store.token, id, { file_url: url }).expect(200);

      const [row] = await dataSource.query(
        `SELECT fileUrl, png, collectBy FROM render_jobs WHERE id = ?`,
        [id],
      );

      expect(row.fileUrl).toBe(url);
      expect(row.png).toBeNull();
      expect(row.collectBy).toBeNull();
    });

    /*
     * ⚠️ **Once collected, the bytes are gone from the cloud** — which is what
     * keeps the buffer a buffer rather than a second home.
     */
    it('has nothing left to serve after collection', async () => {
      const store = await connected();
      const id = await rendered(store.token, store.id);

      await confirm(store.token, id, {
        file_url: 'https://store.test/wp-content/uploads/print.png',
      }).expect(200);

      await fetch(store.token, id).expect(404);
    });

    it('refuses to record a collection for another store’s job', async () => {
      const mine = await connected('a');
      const theirs = await connected('b');
      const id = await rendered(mine.token, mine.id);

      await confirm(theirs.token, id, {
        file_url: 'https://evil.test/stolen.png',
      }).expect(404);
    });

    it.each([
      ['not a url', 'definitely not a url'],
      ['an empty string', ''],
    ])('refuses %s as a file url', async (_name, url) => {
      const store = await connected();
      const id = await rendered(store.token, store.id);

      await confirm(store.token, id, { file_url: url }).expect(400);
    });
  });

  // --- Isolation -----------------------------------------------------------

  describe('store isolation', () => {
    it('refuses an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/v1/store/renders')
        .send(payload())
        .expect(401);
    });

    it('refuses a credential that is not a store token', async () => {
      await ask('not-a-real-token', payload()).expect(401);
    });

    /*
     * 🔴 **A render is billed to a tenant and holds their customer's
     * artwork.** Attributing one store's work to another is the same class of
     * defect as attributing its revenue.
     */
    it('attributes the job to the asking store alone', async () => {
      const mine = await connected('a');
      const theirs = await connected('b');

      await ask(mine.token, payload()).expect(200);

      expect(await jobsFor(mine.id)).toHaveLength(1);
      expect(await jobsFor(theirs.id)).toHaveLength(0);
    });
  });
});
