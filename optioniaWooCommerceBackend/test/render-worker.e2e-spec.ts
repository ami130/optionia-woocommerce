import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import {
  MAX_RENDER_ATTEMPTS,
  RENDER_AFTER_MS,
  RenderWorkerService,
} from '../src/design/render-worker.service';

import { statusOf } from '../src/design/render-jobs.service';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The worker that turns accepted requests into print files (M26e.4).
 *
 * 🔴 **This is where the rasteriser and the font inventory finally run.** Both
 * were built, tested and exempted with a removal stage reading *"the render job
 * is its caller"* — this is that caller.
 *
 * ⚠️ **The claim mechanics are the billing retry's**, deliberately: two workers
 * must not render the same job twice, and a process killed mid-render must
 * still have burned an attempt. Those properties are asserted here rather than
 * inherited on trust.
 */
describe('render worker (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;
  let worker: RenderWorkerService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('rwk264');
    dataSource = app.get(DataSource);
    worker = app.get(RenderWorkerService);

    await harness.cleanup();
    await harness.tenant('a');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  async function store(): Promise<string> {
    const id = await harness.store('a');

    await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
      StoreStatus.CONNECTED,
      id,
    ]);

    return id;
  }

  /** A scene of one coloured rectangle — no text, so it needs no font. */
  const SCENE = {
    width: 40,
    height: 40,
    groups: [
      {
        key: 'g',
        visible: true,
        texts: [],
        images: [
          {
            href: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
            x: 0,
            y: 0,
            w: 40,
            h: 40,
            rot: 0,
            opacity: 1,
            shape: 'none',
          },
        ],
      },
    ],
  };

  /**
   * A job old enough to be claimed.
   *
   * ⚠️ **`createdAt` is backdated past `RENDER_AFTER_MS`**, because the cutoff
   * exists to keep the worker off a row whose accept transaction may still be
   * open — so a freshly inserted job is correctly invisible.
   */
  async function job(
    storeId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const lineRef = `line-${Math.random().toString(36).slice(2, 10)}`;
    const age = new Date(Date.now() - RENDER_AFTER_MS - 5_000);

    await dataSource.query(
      `INSERT INTO render_jobs
         (id, storeId, lineRef, scene, width, height, attempts, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, ?, ?, ?, 0, ?, NOW(3))`,
      [storeId, lineRef, JSON.stringify(overrides.scene ?? SCENE), 40, 40, age],
    );

    const [row]: Array<{ id: string }> = await dataSource.query(
      `SELECT id FROM render_jobs WHERE storeId = ? AND lineRef = ?`,
      [storeId, lineRef],
    );

    return row.id;
  }

  const read = async (id: string): Promise<Record<string, unknown>> => {
    const [row] = await dataSource.query(`SELECT * FROM render_jobs WHERE id = ?`, [id]);

    return row;
  };

  describe('a pass over pending jobs', () => {
    it('renders a job and marks it processed', async () => {
      const id = await job(await store());

      const result = await worker.renderPending();

      expect(result.rendered).toBeGreaterThanOrEqual(1);

      const row = await read(id);

      expect(row.processedAt).not.toBeNull();
      expect(row.deadAt).toBeNull();
      expect(row.lastError).toBeNull();
    });

    /*
     * 🔴 **The attempt is stamped BEFORE the work.** A process killed
     * mid-render must still have burned one, or a job that OOM-kills its
     * container retries for ever — and an OOM kill is precisely the failure
     * that must not loop.
     */
    it('burns an attempt even on success', async () => {
      const id = await job(await store());

      await worker.renderPending();

      expect((await read(id)).attempts).toBe(1);
    });

    /*
     * ⚠️ **The cutoff keeps the worker off a row whose accept transaction may
     * still be open**, so a job inserted this instant is invisible.
     */
    it('leaves a job younger than the cutoff alone', async () => {
      const storeId = await store();
      const lineRef = `fresh-${Math.random().toString(36).slice(2, 8)}`;

      await dataSource.query(
        `INSERT INTO render_jobs
           (id, storeId, lineRef, scene, width, height, attempts, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, 40, 40, 0, NOW(3), NOW(3))`,
        [storeId, lineRef, JSON.stringify(SCENE)],
      );

      await worker.renderPending();

      const [row] = await dataSource.query(
        `SELECT processedAt, attempts FROM render_jobs WHERE storeId = ? AND lineRef = ?`,
        [storeId, lineRef],
      );

      expect(row.processedAt).toBeNull();
      expect(row.attempts).toBe(0);
    });

    it('does not re-render a finished job', async () => {
      const id = await job(await store());

      await worker.renderPending();

      const after = await read(id);

      await worker.renderPending();

      expect((await read(id)).attempts).toBe(after.attempts);
    });

    /*
     * 🔴 **The claim must burn an attempt, and a mutation proved nothing
     * checked it.** Replacing `attempts + 1` with `attempts` left every test
     * green — so a process killed mid-render would have retried for ever, which
     * is the exact failure an OOM kill produces and the one that must not loop.
     *
     * ⚠️ **Asserted ACROSS passes, not within one.** A single pass cannot tell
     * "stamped before the work" from "stamped after"; two failing passes can,
     * because only an incrementing claim reaches the limit.
     */
    it('burns one attempt per pass, so a failing job reaches the limit', async () => {
      const id = await job(await store(), { scene: { width: 0, groups: 'bad' } });

      await worker.renderPending();
      expect((await read(id)).attempts).toBe(1);

      await worker.renderPending();
      expect((await read(id)).attempts).toBe(2);
    });

    /*
     * 🔴 **The defect this test exists for: a rendered job must NOT claim to be
     * ready.** The first version mapped `processedAt !== null → 'ready'`,
     * which was true while rasterising and delivering were one step. Decision
     * 3a split them — the worker makes pixels, the plugin collects them — so a
     * job reported `ready` with `fileUrl: null`, telling a fulfiller the print
     * file was ready when no file existed anywhere.
     *
     * ⚠️ **Not one of twenty-five tests asked what a store is TOLD after a
     * successful render.** They asserted the row and never the answer, which is
     * how a contract defect survives a green suite.
     */
    it('reports a rendered job as rendered, not ready, until a file exists', async () => {
      const storeId = await store();
      const id = await job(storeId);

      await worker.renderPending();

      const row = await read(id);

      expect(row.processedAt).not.toBeNull();
      expect(row.fileUrl).toBeNull();

      /* What the STORE is told, which is the part that was wrong. */
      expect(
        statusOf({
          processedAt: row.processedAt as Date | null,
          deadAt: row.deadAt as Date | null,
          fileUrl: row.fileUrl as string | null,
        }),
      ).toBe('rendered');
    });

    /*
     * ⚠️ **`ready` requires a FILE.** This is the other half: once the plugin
     * has collected the bytes and recorded where they went, the job is ready —
     * and nothing before that is.
     */
    it('reports ready once a file has been collected', async () => {
      const storeId = await store();
      const id = await job(storeId);

      await worker.renderPending();
      await dataSource.query(`UPDATE render_jobs SET fileUrl = ? WHERE id = ?`, [
        'https://store.test/wp-content/uploads/print.png',
        id,
      ]);

      const row = await read(id);

      expect(
        statusOf({
          processedAt: row.processedAt as Date | null,
          deadAt: row.deadAt as Date | null,
          fileUrl: row.fileUrl as string | null,
        }),
      ).toBe('ready');
    });

    /*
     * 🔴 **A design with TEXT renders, which it could not before the fonts
     * shipped.** `resvg` draws `<textPath>` and `<text>` from a font FILE, so
     * until the eight licensed families were in `assets/fonts` every
     * text-bearing design failed with `no-fonts` — correctly refused rather
     * than silently blank, but refused all the same.
     *
     * ⚠️ **Pacifico is deliberately chosen**: it is the one family that ships
     * regular-only, so a fallback to another face would be visible as a
     * different glyph count rather than hidden behind a near-identical weight.
     */
    it('renders a design containing text', async () => {
      const storeId = await store();
      const lineRef = `text-${Math.random().toString(36).slice(2, 8)}`;
      const age = new Date(Date.now() - RENDER_AFTER_MS - 5_000);
      const scene = {
        width: 200,
        height: 60,
        letterbox: { x: 0, y: 0, w: 200, h: 60 },
        groups: [
          {
            key: 't',
            visible: true,
            images: [],
            texts: [
              {
                text: 'Happy Birthday',
                font: 'Pacifico',
                fontSize: 28,
                bold: false,
                italic: false,
                align: 'center',
                valign: 'middle',
                color: '#000000',
                cx: 100,
                cy: 30,
                w: 190,
                h: 0,
                rot: 0,
                curve: 0,
                letterSpacing: 0,
                advanceRatio: 0,
              },
            ],
          },
        ],
      };

      await dataSource.query(
        `INSERT INTO render_jobs
           (id, storeId, lineRef, scene, width, height, attempts, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, 200, 60, 0, ?, NOW(3))`,
        [storeId, lineRef, JSON.stringify(scene), age],
      );

      const result = await worker.renderPending();

      expect(result.rendered).toBe(1);

      const [row] = await dataSource.query(
        `SELECT processedAt, lastError FROM render_jobs WHERE storeId = ? AND lineRef = ?`,
        [storeId, lineRef],
      );

      expect(row.lastError).toBeNull();
      expect(row.processedAt).not.toBeNull();
    });

    /*
     * 🔴 **The bytes are STORED, and for two commits they were not.** The PNG
     * was produced and dropped into a `void` while Decision 3a was open — a
     * worker that silently discarded its own output, with every test green.
     */
    it('stores the rendered bytes in the buffer', async () => {
      const id = await job(await store());

      await worker.renderPending();

      const row = await read(id);
      const png = row.png as Buffer | null;

      expect(png).not.toBeNull();
      expect(png!.length).toBeGreaterThan(0);

      /* ⚠️ A real PNG, not an empty buffer: the 8-byte signature. */
      expect(png!.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    });

    /*
     * 🔴 **An uncollected buffer must be VISIBLE as one.** Decision 3a: *"if
     * collection ever fails silently, the buffer becomes the home by
     * accident."* A deadline makes that queryable rather than inferred.
     */
    it('sets a collection deadline when it stores bytes', async () => {
      const id = await job(await store());

      await worker.renderPending();

      const row = await read(id);

      expect(row.collectBy).not.toBeNull();
      expect((row.collectBy as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('reports nothing to do when the queue is empty', async () => {
      await worker.renderPending();

      expect(await worker.renderPending()).toEqual({
        claimed: 0,
        rendered: 0,
        deadLettered: 0,
      });
    });
  });

  // --- Failure -------------------------------------------------------------

  describe('a scene that cannot be rendered', () => {
    /** A scene the serializer accepts and the rasteriser cannot draw. */
    const BROKEN = { width: 0, height: 0, groups: 'not an array' };

    /*
     * 🔴 **The rasteriser's verdict must be acted on, and a mutation proved
     * nothing checked it.** Treating a failed render as a success left every
     * test green — a job would be marked `processed` with no file ever made,
     * and a fulfiller would wait for artwork that was never coming.
     *
     * ⚠️ **A canvas beyond the megapixel ceiling is the cleanest probe**: it is
     * refused by `checkRenderBounds` inside the rasteriser, so a worker that
     * ignored the verdict would mark it done.
     */
    it('does not mark a refused render as processed', async () => {
      const storeId = await store();
      const lineRef = `huge-${Math.random().toString(36).slice(2, 8)}`;
      const age = new Date(Date.now() - RENDER_AFTER_MS - 5_000);

      await dataSource.query(
        `INSERT INTO render_jobs
           (id, storeId, lineRef, scene, width, height, attempts, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, 50000, 50000, 0, ?, NOW(3))`,
        [storeId, lineRef, JSON.stringify(SCENE), age],
      );

      const result = await worker.renderPending();

      expect(result.rendered).toBe(0);

      const [row] = await dataSource.query(
        `SELECT processedAt, lastError FROM render_jobs WHERE storeId = ? AND lineRef = ?`,
        [storeId, lineRef],
      );

      expect(row.processedAt).toBeNull();
      expect(row.lastError).toContain('too-large');
    });

    it('records why it failed without giving up at once', async () => {
      const id = await job(await store(), { scene: BROKEN });

      const result = await worker.renderPending();

      expect(result.rendered).toBe(0);

      const row = await read(id);

      expect(row.processedAt).toBeNull();
      expect(row.deadAt).toBeNull();
      expect(row.lastError).toBeTruthy();
    });

    /*
     * 🔴 **Dead-lettered at the limit, and the SOURCE IS RETAINED.** M26e.6
     * requires the design survive a permanent failure so it can be re-rendered
     * once whatever broke is fixed — which is why `deadAt` is not a deletion.
     */
    it('gives up after the attempt limit and keeps the scene', async () => {
      const id = await job(await store(), { scene: BROKEN });

      for (let pass = 0; pass < MAX_RENDER_ATTEMPTS; pass += 1) {
        await worker.renderPending();
      }

      const row = await read(id);

      expect(row.attempts).toBe(MAX_RENDER_ATTEMPTS);
      expect(row.deadAt).not.toBeNull();
      expect(row.scene).toBeTruthy();
    });

    /*
     * 🔴 **A dead job must read as `failed`, and a mutation proved nothing
     * checked it.** Removing the `deadAt` test left every test green: a dead
     * row has no `fileUrl` and no `processedAt`, so it falls through to
     * `preparing` — telling a fulfiller their print file is being prepared
     * when it was abandoned. The most misleading answer of the four.
     */
    it('reports a dead job as failed, not preparing', async () => {
      const id = await job(await store(), { scene: BROKEN });

      for (let pass = 0; pass < MAX_RENDER_ATTEMPTS; pass += 1) {
        await worker.renderPending();
      }

      const row = await read(id);

      expect(row.deadAt).not.toBeNull();
      expect(row.processedAt).toBeNull();
      expect(row.fileUrl).toBeNull();

      expect(
        statusOf({
          processedAt: row.processedAt as Date | null,
          deadAt: row.deadAt as Date | null,
          fileUrl: row.fileUrl as string | null,
        }),
      ).toBe('failed');
    });

    it('never claims a dead job again', async () => {
      const id = await job(await store(), { scene: BROKEN });

      for (let pass = 0; pass < MAX_RENDER_ATTEMPTS; pass += 1) {
        await worker.renderPending();
      }

      const dead = await read(id);

      await worker.renderPending();

      expect((await read(id)).attempts).toBe(dead.attempts);
    });

    /*
     * ⚠️ **One bad job must not stop the pass.** A merchant whose design is
     * broken should not block every other merchant's print file.
     */
    it('renders the good jobs in a batch containing a bad one', async () => {
      const storeId = await store();

      await job(storeId, { scene: BROKEN });
      await job(storeId);

      const result = await worker.renderPending();

      expect(result.rendered).toBe(1);
      expect(result.claimed).toBe(2);
    });
  });

  // --- Uncollected buffers --------------------------------------------------

  describe('buffers nobody came for', () => {
    /** Put a job in the state the worker leaves it: bytes held, deadline set. */
    async function buffered(storeId: string, collectBy: Date): Promise<string> {
      const id = await job(storeId);

      await dataSource.query(
        `UPDATE render_jobs
            SET processedAt = NOW(3), png = ?, collectBy = ?
          WHERE id = ?`,
        [Buffer.from([0x89, 0x50, 0x4e, 0x47]), collectBy, id],
      );

      return id;
    }

    const hoursAway = (hours: number): Date =>
      new Date(Date.now() + hours * 60 * 60 * 1000);

    /*
     * 🔴 **This is the symptom Decision 3a names** — *"if collection ever
     * fails silently, the buffer becomes the home by accident."* Without a
     * count, an overdue buffer looks exactly like a healthy one.
     */
    it('counts a buffer past its deadline', async () => {
      const storeId = await store();
      await buffered(storeId, hoursAway(-1));

      expect(await worker.countUncollected(new Date(), storeId)).toBe(1);
    });

    it('ignores a buffer still within its deadline', async () => {
      const storeId = await store();
      await buffered(storeId, hoursAway(1));

      expect(await worker.countUncollected(new Date(), storeId)).toBe(0);
    });

    /*
     * ⚠️ **A collected job is not overdue, however old.** `markCollected`
     * clears both the bytes and the deadline; counting it would report a
     * permanent fault for a transfer that succeeded.
     */
    it('ignores a job whose buffer was collected', async () => {
      const storeId = await store();
      const id = await buffered(storeId, hoursAway(-99));

      await dataSource.query(
        `UPDATE render_jobs SET png = NULL, collectBy = NULL, fileUrl = ? WHERE id = ?`,
        ['https://store.test/print.png', id],
      );

      expect(await worker.countUncollected(new Date(), storeId)).toBe(0);
    });

    /*
     * ⚠️ **Bytes gone, deadline left behind — the state `png IS NOT NULL`
     * exists for.** Clearing both together is the healthy path, and testing
     * only that left the byte check unproven: a mutant that dropped it passed
     * everything. A row can lose its buffer without losing its deadline — a
     * partial write, a hand-run `UPDATE`, a future sweep that clears bytes
     * alone — and counting it would report a fault with nothing to recover.
     */
    it('ignores a row whose bytes are gone but whose deadline remains', async () => {
      const storeId = await store();
      const id = await buffered(storeId, hoursAway(-1));

      await dataSource.query(`UPDATE render_jobs SET png = NULL WHERE id = ?`, [id]);

      expect(await worker.countUncollected(new Date(), storeId)).toBe(0);
    });

    /*
     * 🔴 **It reports; it does not delete.** Destroying the only copy of a
     * customer's artwork exactly when collection is known broken would turn a
     * recoverable fault into an unrecoverable one.
     */
    it('leaves the bytes where they are', async () => {
      const storeId = await store();
      const id = await buffered(storeId, hoursAway(-1));

      await worker.countUncollected(new Date(), storeId);

      const row = await read(id);

      expect(row.png).not.toBeNull();
      expect(row.collectBy).not.toBeNull();
    });
  });
});
