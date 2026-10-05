import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { sceneToSvgString } from '@shared/design/design-scene';

import { loadConfig } from '../config/env';
import { fontInventory, resolveFontsDir } from './design-fonts';
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

      const outcome = this.render(job, fonts.files);

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
        await this.jobs.update(
          { id: job.id },
          { processedAt: new Date(), lastError: null, attempts },
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
  private render(
    job: RenderJob,
    fontFiles: readonly string[],
  ): { ok: true; ms: number } | { ok: false; message: string } {
    let svg: string;

    try {
      /*
       * 🔴 **The scene was snapshotted at accept time**, so this renders what
       * the customer bought rather than what the configuration later became.
       * It is handed to the SHARED serializer — the same one the dashboard
       * preview and the storefront draw with, which is what makes the print
       * file match the preview a merchant approved.
       */
      svg = sceneToSvgString(job.scene as never, `job-${job.id}`);
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
     * ⚠️ **The PNG is produced and not yet stored, which is Decision 3a's
     * open half.** The bytes cross to the merchant's WordPress through a
     * short-lived signed URL the plugin pulls; until that transfer lands, a
     * rendered job is `processed` with no `fileUrl`. Recorded here rather than
     * hidden, because a worker that silently discarded its own output would be
     * the worst kind of green.
     */
    void outcome.result.png;

    return { ok: true, ms: outcome.result.ms };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
