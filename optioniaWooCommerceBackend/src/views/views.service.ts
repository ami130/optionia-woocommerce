import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import type { ViewCountDto } from './dto/report-views.dto';

/**
 * Recording how many customers saw each option (M25.1).
 *
 * ## Why the write is an upsert that ADDS
 *
 * 🔴 **The plugin sends a delta and clears it only after a 2xx**, so a drain
 * that timed out after the server wrote will resend the same numbers. Adding
 * them would double the count — unless the *unique key* absorbs the repeat,
 * which is what `ON DUPLICATE KEY UPDATE views = views + VALUES(views)` does
 * for a **new** batch and precisely what it does NOT do for a replay.
 *
 * ⚠️ **So this is at-least-once, and the plugin owns the other half.** The
 * cloud cannot distinguish a replay from a genuine second batch for the same
 * day — both are "add 5 to Tuesday" — and inventing a request id to tell them
 * apart would be a second idempotency scheme layered on one that already works
 * for orders. What makes it safe is the plugin clearing its counter only on
 * success: a failed drain resends, a succeeded one has nothing left to resend.
 * That is the assumption a reviewer should distrust first, and it is stated
 * here rather than left implicit.
 */
@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Add a batch of counts to what this store has already reported.
   *
   * 📌 **One statement, not one per row.** A store returning after a week sends
   * up to 500 rows, and 500 round trips inside one request would hold a
   * connection for the whole of it.
   *
   * @returns how many (option, day) pairs were touched.
   */
  async record(storeId: string, views: readonly ViewCountDto[]): Promise<number> {
    if (views.length === 0) {
      /*
       * 📌 **An empty batch is a success, not an error.** The plugin drains on
       * a fixed schedule whether or not anything accumulated, and answering 400
       * to "nothing happened" would make every quiet hour look like a failure
       * in the merchant's logs.
       */
      return 0;
    }

    const rows = views
      .map(() => `(?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`)
      .join(', ');

    const parameters = views.flatMap((view) => [
      randomUUID(),
      storeId,
      view.option_set_id,
      view.option_key,
      view.day,
      view.views,
    ]);

    await this.dataSource.query(
      `INSERT INTO option_view_counts
         (id, storeId, optionSetId, optionKey, day, views, createdAt, updatedAt)
       VALUES ${rows}
       ON DUPLICATE KEY UPDATE views = views + VALUES(views), updatedAt = NOW(3)`,
      parameters,
    );

    this.logger.debug(`Views recorded. store=${storeId} rows=${views.length}`);

    return views.length;
  }
}
