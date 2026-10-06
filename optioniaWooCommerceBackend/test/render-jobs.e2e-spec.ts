import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';
import { MAX_RENDER_MEGAPIXELS } from '../src/common/render/render-bounds';

import { RenderWorkerService } from '../src/design/render-worker.service';
import { statusOf } from '../src/design/render-jobs.service';
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

  // --- The whole chain -----------------------------------------------------

  describe('a print file, from request to ready', () => {
    /*
     * 🔴 **Every other test here proves one link.** Acceptance, rasterising,
     * serving bytes and recording collection each have their own coverage, and
     * all of it passed while the pipeline had never once run end to end — the
     * production database holds fourteen published option sets, zero designs
     * and zero render jobs.
     *
     * ⚠️ **This walks the chain a merchant's order actually takes**: the store
     * asks, the worker renders, the plugin fetches the bytes, the plugin
     * confirms, and only then is the job `ready` with its buffer released. A
     * break anywhere between those steps is invisible to the per-link tests,
     * because each one sets up the state the previous step was supposed to
     * produce.
     */
    it('walks accept → render → fetch → confirm → ready', async () => {
      const store = await connected();
      const worker = app.get(RenderWorkerService);

      // 1. The store asks for a print file.
      const accepted = await ask(store.token, payload()).expect(200);
      const jobId = accepted.body.data.id as string;

      expect(accepted.body.data.status).toBe('preparing');

      // 2. The worker renders it. `RENDER_AFTER_MS` excludes anything newer
      //    than five seconds, so the row is aged as the scheduler would find it.
      await dataSource.query(
        `UPDATE render_jobs SET createdAt = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?`,
        [jobId],
      );

      const pass = await worker.renderPending();

      expect(pass.rendered).toBe(1);

      const [rendered] = await dataSource.query(
        `SELECT processedAt, deadAt, fileUrl, png, collectBy FROM render_jobs WHERE id = ?`,
        [jobId],
      );

      expect(rendered.processedAt).not.toBeNull();
      expect(rendered.png).not.toBeNull();
      expect(statusOf(rendered)).toBe('rendered');

      // 3. The plugin fetches the bytes.
      const file = await request(app.getHttpServer())
        .get(`/v1/store/renders/${jobId}/file`)
        .set('Authorization', `Bearer ${store.token}`)
        .expect(200);

      const bytes = Buffer.isBuffer(file.body) ? file.body : Buffer.from(String(file.text));

      expect(file.headers['content-type']).toContain('image/png');

      /*
       * 📌 **The signature is checked here too**, because this is the byte
       * stream the plugin's own PNG check reads. A route that answered a JSON
       * error with a 200 would pass a length assertion and fail a print shop.
       */
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(Number(file.headers['content-length'])).toBe(bytes.length);

      // 4. The plugin confirms it holds the file.
      await request(app.getHttpServer())
        .post(`/v1/store/renders/${jobId}/collected`)
        .set('Authorization', `Bearer ${store.token}`)
        .send({ file_url: 'https://optionia.local/wp-admin/admin.php?page=print' })
        .expect(200);

      // 5. Only now is it ready, and the cloud no longer holds the bytes.
      const [done] = await dataSource.query(
        `SELECT processedAt, deadAt, fileUrl, png, collectBy FROM render_jobs WHERE id = ?`,
        [jobId],
      );

      expect(statusOf(done)).toBe('ready');
      expect(done.png).toBeNull();
      expect(done.collectBy).toBeNull();

      /*
       * ⚠️ **And the buffer is gone for good.** `countUncollected()` watches
       * for a transfer that never completed; a job that kept its bytes after
       * confirming would make the database a second home for artwork.
       */
      await request(app.getHttpServer())
        .get(`/v1/store/renders/${jobId}/file`)
        .set('Authorization', `Bearer ${store.token}`)
        .expect(404);
    }, 60_000);
  });

  // --- Preview -------------------------------------------------------------

  describe('the storefront overlay', () => {
    const preview = (token: string, body: object): request.Test =>
      request(app.getHttpServer())
        .post('/v1/store/preview')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    /*
     * ⚠️ **Supertest has no parser for `image/svg+xml`**, so it hands the body
     * back as a Buffer and leaves `response.text` undefined. Reading `.text`
     * silently compared against `undefined`, which `toContain` rejects — the
     * route was correct and the assertion was looking in the wrong place.
     */
    const svgOf = (response: request.Response): string =>
      Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.text ?? '');

    /**
     * A scene in the shape the PLUGIN sends.
     *
     * 🔴 **This fixture described the serializer's input, not the plugin's
     * output**, and that hid the same defect the worker had: `buildScene` was
     * never called, so a real composed scene drew nothing. `layers` in
     * fractions is what `Engine\SceneComposer` emits.
     */
    /*
     * 🔴 **Deliberately DISAGREES with the posted width/height.** A scene
     * carrying its own dimensions made the route's `width: dto.width` override
     * unobservable — dropping it changed nothing and the mutant survived. The
     * posted dimensions are what `checkRenderBounds` judged, so they are what
     * must reach `viewBox`; a scene that could override them would route around
     * the ceiling.
     */
    const scene = (): Record<string, unknown> => ({
      width: 999,
      height: 999,
      groups: [
        {
          key: 'badge',
          visible: true,
          layers: [
            {
              name: 'badge',
              src: 'https://cdn.test/badge.png',
              natW: 120,
              natH: 90,
              pos: { xPct: 0.25, yPct: 0.25, wPct: 0.3, hPct: 0.225 },
              rot: 0,
              style: {},
              visible: true,
            },
          ],
        },
      ],
    });

    it('answers an SVG a browser can mount', async () => {
      const store = await connected();

      const response = await preview(store.token, {
        scene: scene(),
        width: 400,
        height: 400,
      }).expect(200);

      expect(response.headers['content-type']).toContain('image/svg+xml');
      expect(svgOf(response)).toContain('<svg');
      expect(svgOf(response)).toContain('viewBox="0 0 400 400"');
    });

    /*
     * 🔴 **The property the whole route exists for.** The storefront preview
     * and the print file must be the same picture, and the only way to
     * guarantee that is for both to come out of the SAME serializer. This
     * asserts the scene's content actually reaches the document, so a route
     * that answered a valid but empty `<svg>` would fail here.
     */
    it('draws the layers the scene carries', async () => {
      const store = await connected();

      const response = await preview(store.token, {
        scene: scene(),
        width: 400,
        height: 400,
      }).expect(200);

      expect(svgOf(response)).toContain('https://cdn.test/badge.png');
      /* 0.3 × 400 = 120: the fraction resolved to a pixel width. */
      expect(svgOf(response)).toContain('width="120"');
    });

    /*
     * 📌 **`data-design-bg` is what makes overlay mode possible.** The
     * storefront drops that node so the theme's real product image shows
     * through underneath; without the marker it would have to guess which
     * element was the background.
     */
    it('marks the background so the storefront can drop it', async () => {
      const store = await connected();

      const response = await preview(store.token, {
        scene: { ...scene(), backgroundHref: 'https://cdn.test/mug.png' },
        width: 400,
        height: 400,
      }).expect(200);

      expect(svgOf(response)).toContain('data-design-bg="1"');
    });

    it('refuses a canvas beyond the render ceiling', async () => {
      const store = await connected();

      await preview(store.token, {
        scene: scene(),
        width: 50_000,
        height: 50_000,
      }).expect(400);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer())
        .post('/v1/store/preview')
        .send({ scene: scene(), width: 400, height: 400 })
        .expect(401);
    });

    /*
     * ⚠️ **Nothing is stored.** A preview belongs to no cart line, so a route
     * that queued a job would fill the table with work nobody asked for — one
     * row per keystroke.
     */
    it('records no render job', async () => {
      const store = await connected();

      await preview(store.token, { scene: scene(), width: 400, height: 400 }).expect(200);

      expect(await jobsFor(store.id)).toHaveLength(0);
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
