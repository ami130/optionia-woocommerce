import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { buildScene, sceneToSvgString } from '@shared/design/design-scene';

import { loadConfig } from '../config/env';
import { fontInventory, resolveFontsDir } from './design-fonts';
import { inlineSceneImages } from './layer-images';
import { RenderJob } from './entities/render-job.entity';
import { rasteriseScene } from './scene-raster';

/**
 * 🔴 **Three, not five, and the difference is deliberate.** A billing event is
 * retried five times because its failure is usually transient — a provider
 * blip, a database stall. A render failure is usually the SCENE: a design that
 * references an image which no longer loads fails identically every time.
 * Re-running it five times costs five rasterisations to learn what two already
 * said.
 */
export const MAX_RENDER_ATTEMPTS = 3;

/**
 * 📌 **Old enough that the request which wrote it is certainly over.** A job is
 * inserted by `POST /store/renders` and the row exists before anything renders
 * it, so without this a job could be claimed while its own accept transaction
 * was still open — the same reason `RETRY_AFTER_MS` exists for billing events.
 */
export const RENDER_AFTER_MS = 5_000;

/** How many jobs one pass takes. */
const BATCH = 10;

/**
 * How long a rendered file waits in the buffer before it is a problem.
 *
 * 🔴 **Twenty-four hours, and it is a diagnosis window rather than a deadline.**
 * The plugin's own cron runs far more often than daily, so a buffer still
 * uncollected after a day means collection is broken — not that it is slow.
 * Decision 3a: *"if collection ever fails silently, the buffer becomes the home
 * by accident."*
 */
export const COLLECT_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * Turning accepted render requests into print files (M26e.4).
 *
 * ## Why this is a worker rather than a request handler
 *
 * 🔴 **Decision 2 ruled out synchronous rendering on measured numbers** — 8 s,
 * 20 s, 5 MB — and the customer has already checked out by the time the file
 * matters. So `POST /store/renders` records and returns; this is what actually
 * does the work, where the fonts, the memory and the CPU are.
 *
 * ## Why the claim looks like the billing retry's
 *
 * 📌 **Because the problem is the same one, already solved** (F125). Two
 * workers running the same pass must not render the same job twice, so rows are
 * claimed with `FOR UPDATE SKIP LOCKED` — the second worker sees fewer rows and
 * does the remaining work rather than blocking. The claim is its own short
 * transaction: holding a lock across a rasterisation would stall every other
 * worker for the length of a render.
 *
 * ⚠️ **`attempts` is incremented BEFORE the work**, so a process killed
 * mid-render still burns an attempt. Incrementing on completion would let a job
 * that OOM-kills its container retry for ever — and an OOM kill is exactly the
 * failure `checkRenderBounds` exists for, which means it is exactly the one
 * that must not loop.
 */
@Injectable()
export class RenderWorkerService {
  private readonly logger = new Logger(RenderWorkerService.name);

  constructor(
    @InjectRepository(RenderJob)
    private readonly jobs: Repository<RenderJob>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Take ownership of up to {@link BATCH} renderable jobs.
   *
   * 🔴 **Three conditions, each load-bearing.** `processedAt IS NULL` is "never
   * finished"; `deadAt IS NULL` excludes what was already given up on, or a
   * deterministic failure would be re-run for ever; and the age cutoff keeps
   * this off a row whose accept transaction may still be open.
   */
  private async claim(cutoff: Date): Promise<RenderJob[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .createQueryBuilder(RenderJob, 'j')
        .where('j.processedAt IS NULL')
        .andWhere('j.deadAt IS NULL')
        .andWhere('j.createdAt < :cutoff', { cutoff })
        .orderBy('j.createdAt', 'ASC')
        .limit(BATCH)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (rows.length === 0) {
        return [];
      }

      await manager
        .createQueryBuilder()
        .update(RenderJob)
        .set({ attempts: () => 'attempts + 1' })
        .whereInIds(rows.map((row) => row.id))
        .execute();

      /*
       * 📌 **The in-memory copies must agree with the row just written.**
       *
       * ⚠️ **This makes the SQL increment look redundant, and it is not — a
       * mutation showed the difference is invisible to a SINGLE worker.**
       * Removing `attempts + 1` above left every test green, because both the
       * success and failure branches write this value back, so the count still
       * advances. What is lost is what the UPDATE is actually for: the claim
       * becomes visible to a second worker the moment it commits, rather than
       * when the first worker finishes rendering. With one worker in a test
       * there is no second reader, so nothing can observe it.
       *
       * 🔴 **Recorded as an equivalent mutant under test rather than tested
       * around.** A fixture that forced two concurrent workers would be
       * asserting MySQL's locking rather than this code, and the property that
       * matters — `FOR UPDATE SKIP LOCKED` plus a committed increment — is the
       * same one `BillingEventRetryService` already relies on.
       */
      return rows.map((row) => Object.assign(row, { attempts: row.attempts + 1 }));
    });
  }

  /**
   * One pass over the renderable jobs.
   *
   * ⚠️ **Returns counts rather than logging only**, so a test can assert what
   * happened without reading log output — the same reason the billing retry
   * does.
   */
  async renderPending(now: Date = new Date()): Promise<{
    claimed: number;
    rendered: number;
    deadLettered: number;
  }> {
    const cutoff = new Date(now.getTime() - RENDER_AFTER_MS);
    const pending = await this.claim(cutoff);

    if (pending.length === 0) {
      return { claimed: 0, rendered: 0, deadLettered: 0 };
    }

    /*
     * 🔴 **The fonts are established ONCE per pass, not per job.** Reading the
     * directory per render would be a filesystem call in a loop for an answer
     * that cannot change mid-pass — and `resvg` renders a missing font file
     * silently, so what is on disk has to be known rather than hoped.
     */
    const fonts = fontInventory(resolveFontsDir(loadConfig().designFontsDir));

    if (fonts.missing.length > 0) {
      /*
       * ⚠️ **A warning, not a refusal.** A design of images alone needs no
       * font, and `rasteriseScene` refuses a scene that draws text without
       * one — so the render that actually needs the missing family fails with
       * a reason, while the rest proceed.
       */
      this.logger.warn(
        `Rendering without ${fonts.missing.length} licensed famil(y/ies): ` +
          `${fonts.missing.join(', ')}. Text in those faces will not draw.`,
      );
    }

    let rendered = 0;
    let deadLettered = 0;

    for (const job of pending) {
      /* 📌 Already incremented by `claim()`; this is the value now in the row. */
      const attempts = job.attempts;

      const outcome = await this.render(job, fonts.files);

      if (outcome.ok) {
        /*
         * ⚠️ **`lastError` is cleared on success.** A job that recovered but
         * still carried its first failure's message would read as a permanent
         * failure to whoever queries these later.
         *
         * 🔴 **`processedAt` is set and `fileUrl` is NOT.** Decision 3a: the
         * bytes are collected by the plugin and the URL is its answer, not
         * ours. A job that is processed with no `fileUrl` is awaiting
         * collection — and one that stays that way is the symptom M26e.6 has
         * to catch.
         */
        /*
         * 🔴 **The bytes are STORED, not discarded.** They waited in a `void`
         * for two commits while Decision 3a was open; the buffer is where they
         * wait now, until the plugin collects them.
         *
         * ⚠️ **`collectBy` is set in the same write.** A buffer with no
         * deadline is one nobody can tell is abandoned, which is the exact
         * drift Decision 3a warns about.
         */
        await this.jobs.update(
          { id: job.id },
          {
            processedAt: new Date(),
            /*
             * 🔴 **A partial render keeps its reason** (F173). Clearing this
             * to null on every success is what let a BLANK print file report
             * `ready` with nothing recorded anywhere — the merchant's first
             * real order. A file that drew some of its layers is still worth
             * delivering, and the reason it is incomplete must outlive the
             * log line that noticed.
             */
            lastError: outcome.imageFailures === '' ? null : outcome.imageFailures,
            attempts,
            png: outcome.png,
            collectBy: new Date(Date.now() + COLLECT_WITHIN_MS),
          },
        );

        rendered += 1;

        this.logger.log(
          `Rendered job ${job.id} (${job.width}×${job.height}) on attempt ` +
            `${attempts} in ${outcome.ms}ms`,
        );

        continue;
      }

      /*
       * 🔴 **Give up at the limit, and record WHEN.** Without `deadAt` a
       * deterministically failing scene — a malformed design, an image that
       * will never load — is re-rendered every cycle until a person notices.
       */
      const dead = attempts >= MAX_RENDER_ATTEMPTS;

      await this.jobs.update(
        { id: job.id },
        { lastError: outcome.message, attempts, deadAt: dead ? new Date() : null },
      );

      if (dead) {
        deadLettered += 1;

        /*
         * 🔴 **`error` level, because this needs a person.** M26e.6: the order
         * is flagged for manual attention and the SOURCE DESIGN IS RETAINED,
         * which is why `deadAt` is not a deletion — the scene stays so it can
         * be re-rendered once whatever broke is fixed.
         */
        this.logger.error(
          `Dead-lettered render ${job.id} after ${attempts} attempt(s): ${outcome.message}`,
        );
      } else {
        this.logger.warn(
          `Render ${attempts}/${MAX_RENDER_ATTEMPTS} failed for ${job.id}: ${outcome.message}`,
        );
      }
    }

    return { claimed: pending.length, rendered, deadLettered };
  }

  /**
   * Rasterise one job's scene.
   *
   * ⚠️ **Synchronous, and that is `resvg`.** The render is a native call no
   * timer can interrupt, which is why `MAX_RENDER_MS` is enforced by
   * measurement inside `rasteriseScene` rather than by cancellation here.
   */
  private async render(
    job: RenderJob,
    fontFiles: readonly string[],
  ): Promise<
    | { ok: true; ms: number; png: Buffer; imageFailures: string }
    | { ok: false; message: string }
  > {
    let svg: string;
    let imageFailures = '';

    try {
      /*
       * 🔴 **The scene was snapshotted at accept time**, so this renders what
       * the customer bought rather than what the configuration later became.
       * It is handed to the SHARED serializer — the same one the dashboard
       * preview and the storefront draw with, which is what makes the print
       * file match the preview a merchant approved.
       */
      /*
       * 🔴 **`buildScene` FIRST, and its absence shipped a blank print file.**
       * The stored scene is what the plugin composed: groups of `layers` in
       * FRACTIONS of the canvas, plus `textOptions`. `sceneToSvgString` reads
       * neither — it wants `images` and `texts` already resolved to viewBox
       * pixels — so serialising the stored shape directly threw
       * `Cannot read properties of undefined (reading 'forEach')` and every
       * real designed order dead-lettered after three attempts.
       *
       * ⚠️ **Measured on a live render, not reasoned about.** A probe queued
       * through the running worker produced a valid 600×600 PNG with nothing
       * drawn on it; the unit and e2e suites all passed, because every fixture
       * was written in the RESOLVED shape the serializer wanted rather than
       * the shape the plugin actually sends.
       *
       * 📌 **This is the one place the fractions become pixels**, which is why
       * M26e.1 can forbid geometry in PHP: the plugin copies a design through
       * untouched and the shared module resolves it here, for the print file
       * and the storefront preview alike.
       */
      /*
       * 🔴 **Images are inlined before anything is drawn (F173).** `resvg`
       * renders only `data:` URIs — measured, a remote `https://` produces a
       * 556-byte BLANK canvas and reports success — while the Design Lab
       * requires `http(s)` and refuses `data:`, because `data:` can carry SVG.
       * So without this step no image layer could ever print, and a merchant's
       * first real order produced an empty 2000×2000 file reported as `ready`.
       *
       * ⚠️ **A refused image does not stop the render.** A design is often
       * text plus artwork, and refusing the whole job over one unreachable
       * badge would turn a partial print file into none at all — M26e.6's
       * first rule is that artwork never blocks a sale, and the same logic
       * holds here. What must not happen is SILENCE, so the reasons are
       * recorded on the job.
       */
      const inlined = await inlineSceneImages(job.scene as Record<string, unknown>);

      if (inlined.refused.length > 0) {
        imageFailures = inlined.refused
          .map((entry) => `${entry.reason}: ${entry.src.slice(0, 120)}`)
          .join('; ');

        this.logger.warn(
          `Render ${job.id}: ${inlined.refused.length} layer image(s) could not be drawn — ${imageFailures}`,
        );
      }

      svg = sceneToSvgString(buildScene(inlined.scene as never), `job-${job.id}`);
    } catch (error) {
      return {
        ok: false,
        message: `The stored scene could not be serialized: ${messageOf(error)}`,
      };
    }

    const outcome = rasteriseScene(svg, job.width, job.height, { files: fontFiles });

    if (!outcome.ok) {
      return { ok: false, message: `${outcome.failure.reason}: ${outcome.failure.message}` };
    }

    /*
     * 📌 **The bytes go back to the caller, which stores them in the buffer.**
     * For two commits this line was a `void` — the PNG produced and dropped —
     * because Decision 3a was still open. It is recorded here because a worker
     * that silently discards its own output is the worst kind of green.
     */
    return { ok: true, ms: outcome.result.ms, png: outcome.result.png, imageFailures };
  }

  /**
   * Count the buffers nobody came for (M26e.4, Decision 3a).
   *
   * 🔴 **This is the thing that notices.** `collectBy` and
   * `ix_render_jobs_uncollected` were written, cleared and indexed for two
   * commits with NOTHING reading them — a deadline no query asked about, which
   * is indistinguishable from no deadline at all. Decision 3a names exactly
   * this drift: *"if collection ever fails silently, the buffer becomes the
   * home by accident."* A buffer only stays a buffer if someone is counting.
   *
   * 🔴 **It REPORTS; it does not delete.** Deleting an overdue buffer would
   * destroy the merchant's only copy of a customer's artwork precisely when
   * collection is known to be broken — turning a recoverable fault into an
   * unrecoverable one. The bytes are the evidence and the remedy at once, so
   * they are kept and the condition is made loud.
   *
   * ⚠️ **Past `collectBy` means collection is BROKEN, not slow.** The plugin's
   * cron runs far more often than daily, so a buffer still uncollected after
   * `COLLECT_WITHIN_MS` is a fault to investigate rather than a wait.
   */
  async countUncollected(now: Date = new Date(), storeId?: string): Promise<number> {
    /*
     * ⚠️ **Counts every store by default, because the signal is operational.**
     * One merchant's plugin failing to collect and a platform-wide fault look
     * identical from inside a single tenant. `storeId` narrows it — which is
     * what a test needs to assert about rows it created, and what an operator
     * needs to name the affected merchant.
     */
    const [row]: Array<{ overdue: string | number }> = await this.dataSource.query(
      `SELECT COUNT(*) AS overdue
         FROM render_jobs
        WHERE collectBy IS NOT NULL
          AND collectBy < ?
          AND png IS NOT NULL
          AND (? IS NULL OR storeId = ?)`,
      [now, storeId ?? null, storeId ?? null],
    );

    /*
     * 📌 **`COUNT(*)` arrives as a string from this driver.** Returned as a
     * number so a caller cannot accidentally compare `"0" > 0` — which is
     * false — and conclude all is well.
     */
    return Number(row?.overdue ?? 0);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
