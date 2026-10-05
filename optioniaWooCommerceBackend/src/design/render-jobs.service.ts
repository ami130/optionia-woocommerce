import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { checkRenderBounds } from '../common/render/render-bounds';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * Accepting a render request, and saying what became of it (M26e.4).
 *
 * 🔴 **Accepting is not rendering.** Decision 2 chose asynchronous on measured
 * numbers — a synchronous render was 8 s, 20 s, 5 MB — so this records the
 * request and returns. The customer has already checked out; nothing waits.
 *
 * ⚠️ **M26e.6's first rule governs the whole design: never block a sale on
 * artwork generation.** That is why acceptance is a row and not a render, and
 * why the plugin can treat a failure here as "no preview" rather than "no
 * purchase".
 */

/** What the store is told when a render is accepted. */
export interface AcceptedRender {
  readonly id: string;
  /** True when this line already had a job — a retry, not a second file. */
  readonly duplicate: boolean;
  readonly status: RenderStatus;
  readonly fileUrl: string | null;
}

/**
 * Where a job has got to, in terms a fulfiller can be shown.
 *
 * 📌 **`preparing` exists because Decision 2 calls it a milestone**: *"a
 * fulfiller opening an order in the first seconds must see 'the print file is
 * being prepared', never a broken image and never silence."*
 */
export type RenderStatus = 'preparing' | 'ready' | 'failed';

export interface RenderRequest {
  readonly lineRef: string;
  readonly scene: Record<string, unknown>;
  readonly width: number;
  readonly height: number;
}

@Injectable()
export class RenderJobsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Record one render request, idempotently.
   *
   * 🔴 **An upsert rather than a check-then-insert**, for the reason
   * `OrdersService.report` records: the plugin retries whenever a response is
   * sent but never received, and WordPress cron is not single-threaded, so two
   * passes can reach the insert at once. A `SELECT` then `INSERT` looks like it
   * handles that and does not — one would win and the other would surface a
   * raw constraint violation as a 500, telling a correctly-behaving plugin to
   * retry for ever. `uq_render_jobs_line` makes the race impossible.
   *
   * ⚠️ **A duplicate does NOT overwrite the scene.** This is the one place
   * where this differs from the order upsert, and the difference is the point:
   * M26e.4 requires that *"a retry must not produce a second file"*, so a
   * second request for a line that already has one is answered with the
   * existing job rather than restarting it. Overwriting would discard a
   * finished render and re-do the work.
   *
   * 📌 **The bounds are checked HERE, at the door.** An unbounded canvas is an
   * OOM kill the worker cannot survive and cannot report — refusing it at
   * acceptance means the store learns immediately, rather than a job dying
   * silently hours later.
   */
  async accept(storeId: string, request: RenderRequest): Promise<AcceptedRender> {
    const refused = checkRenderBounds(request.width, request.height);

    if (refused !== null) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, refused.message);
    }

    return this.dataSource.transaction(async (manager) => {
      /*
       * ⚠️ **No `LAST_INSERT_ID(id)`**, for the reason the order upsert
       * records: it takes an integer and this id is `char(36)`, so MySQL
       * answers `Truncated incorrect INTEGER value` and the request 500s. The
       * `SELECT` below reads the id on both paths.
       *
       * 📌 **`updatedAt` is touched on a duplicate and nothing else is.** It
       * records that the store asked again — useful when diagnosing a plugin
       * that is retrying more than it should — without disturbing the job.
       */
      const result: { affectedRows: number } = await manager.query(
        `INSERT INTO render_jobs
           (id, storeId, lineRef, scene, width, height, attempts, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, ?, ?, 0, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE updatedAt = NOW(3)`,
        [
          storeId,
          request.lineRef,
          JSON.stringify(request.scene),
          Math.round(request.width),
          Math.round(request.height),
        ],
      );

      const [row]: Array<{
        id: string;
        processedAt: Date | null;
        deadAt: Date | null;
        fileUrl: string | null;
      }> = await manager.query(
        `SELECT id, processedAt, deadAt, fileUrl
           FROM render_jobs
          WHERE storeId = ? AND lineRef = ?
          LIMIT 1`,
        [storeId, request.lineRef],
      );

      if (!row) {
        /*
         * Unreachable: the upsert above either inserted or matched. Asserted
         * rather than non-null-asserted, so a future change that breaks the
         * invariant fails loudly instead of returning an undefined id.
         */
        throw new DomainException(
          ErrorCode.INTERNAL_ERROR,
          'The render job could not be read back after it was recorded.',
        );
      }

      return {
        id: row.id,
        /*
         * 🔴 **The DATABASE says whether this was a duplicate, not the row's
         * contents.** MySQL reports 1 for an insert and 2 for an update
         * through this path, so anything other than 1 means the row already
         * existed — the same reading `OrdersService.report` relies on.
         *
         * ⚠️ **Inferring it from the columns was wrong, and a test caught
         * it.** The first version read `attempts > 0 || processedAt !== null`,
         * which is false for the commonest retry of all: a plugin asking again
         * seconds later, before the worker has touched the job. It reported a
         * duplicate as fresh while correctly refusing to create a second row —
         * right behaviour, wrong answer.
         */
        duplicate: result.affectedRows !== 1,
        status: statusOf(row),
        fileUrl: row.fileUrl,
      };
    });
  }
}

/**
 * How a row reads to a fulfiller.
 *
 * 🔴 **`deadAt` is checked BEFORE `processedAt`.** A job can be both — a render
 * that succeeded after earlier failures is ready — but a dead one never has a
 * `processedAt`, so testing dead first keeps the two from being confused if
 * that ever changes.
 */
export function statusOf(row: {
  processedAt: Date | null;
  deadAt: Date | null;
}): RenderStatus {
  if (row.deadAt !== null) return 'failed';
  if (row.processedAt !== null) return 'ready';

  return 'preparing';
}
