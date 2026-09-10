import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ReportOrderDto } from './dto/report-order.dto';

/** What the plugin learns from a successful report. */
export interface ReportOrderResult {
  /** The stored event's id, so a retry can be correlated in logs. */
  id: string;

  /**
   * Whether this call created the row or matched an existing one.
   *
   * The plugin does not branch on it — both outcomes mean "stop retrying" — but
   * it makes a duplicate visible in logs instead of looking like a fresh write.
   */
  duplicate: boolean;
}

/**
 * Order reporting (M12.7).
 *
 * Analytics input for [Phase 25], written by the plugin after checkout
 * completes. Two properties matter more than anything else here.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Record one order, idempotently.
   *
   * ## Why an upsert rather than a check-then-insert
   *
   * The plugin retries on transport failure, so the same order arrives twice
   * whenever a response is sent but never received. A `SELECT` followed by an
   * `INSERT` looks like it handles that and does not: WordPress cron is not
   * single-threaded, two overlapping drains can both find no row, and both then
   * insert. One would win and the other would surface a raw constraint
   * violation as a 500 — telling a correctly-behaving plugin to retry forever.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE` against
   * `uq_order_events_external (storeId, externalOrderId)` makes the race
   * impossible rather than unlikely: the database resolves it, and a duplicate
   * is a normal 200.
   *
   * ## Why the whole thing is one transaction
   *
   * A retry must **replace** the selections, not append to them. Appending
   * would double-count every option on the second delivery — precisely the
   * analytics corruption idempotency exists to prevent. So the children are
   * deleted and reinserted, and that is only safe atomically: a failure between
   * the two would leave an order with no selections, which reads as a plain
   * product sale rather than as a missing write.
   */
  async report(storeId: string, dto: ReportOrderDto): Promise<ReportOrderResult> {
    const occurredAt = new Date(dto.occurred_at);

    if (Number.isNaN(occurredAt.getTime())) {
      // `@IsISO8601()` accepts shapes `Date` still cannot parse.
      throw new DomainException(ErrorCode.VALIDATION_FAILED, 'occurred_at is not a valid date.');
    }

    return this.dataSource.transaction(async (manager) => {
      /**
       * **No `LAST_INSERT_ID(id)` here, deliberately.**
       *
       * That is the usual MySQL idiom for reading back an upserted key, and it
       * is wrong for this table: it takes an *integer*, and `order_events.id`
       * is `char(36)`. MySQL answers `Truncated incorrect INTEGER value` and
       * the whole report 500s — measured, on the first run of the idempotency
       * tests. The `SELECT` below reads the id on both paths without it.
       */
      const result: { affectedRows: number } = await manager.query(
        `INSERT INTO order_events
           (id, storeId, externalOrderId, orderTotalMinor, currency,
            optionRevenueMinor, occurredAt, raw, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, NULL, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           orderTotalMinor = VALUES(orderTotalMinor),
           currency = VALUES(currency),
           optionRevenueMinor = VALUES(optionRevenueMinor),
           occurredAt = VALUES(occurredAt),
           updatedAt = NOW(3)`,
        [
          storeId,
          dto.external_order_id,
          dto.order_total_minor,
          dto.currency.toUpperCase(),
          dto.option_revenue_minor ?? 0,
          occurredAt,
        ],
      );

      /**
       * MySQL reports 1 for an insert and 2 for an update through this path, so
       * anything other than 1 means the row already existed.
       */
      const duplicate = result.affectedRows !== 1;

      const [row]: Array<{ id: string }> = await manager.query(
        `SELECT id FROM order_events WHERE storeId = ? AND externalOrderId = ? LIMIT 1`,
        [storeId, dto.external_order_id],
      );

      if (!row) {
        // Unreachable inside the transaction that just wrote it.
        throw new DomainException(ErrorCode.INTERNAL_ERROR, 'Order event could not be recorded.');
      }

      // Replace, never append. See the method docblock.
      await manager.query(`DELETE FROM order_selections WHERE orderEventId = ?`, [row.id]);

      if (dto.selections.length > 0) {
        const values = dto.selections
          .map(() => `(UUID(), ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`)
          .join(', ');

        const parameters = dto.selections.flatMap((selection) => [
          row.id,
          selection.option_key,
          selection.option_label,
          selection.value_key ?? null,
          selection.value_label ?? null,
          selection.price_delta_minor,
          selection.config_version ?? 0,
        ]);

        await manager.query(
          `INSERT INTO order_selections
             (id, orderEventId, optionKey, optionLabel, valueKey, valueLabel,
              priceDeltaMinor, configVersion, createdAt, updatedAt)
           VALUES ${values}`,
          parameters,
        );
      }

      this.logger.debug(
        `Order reported. store=${storeId} order=${dto.external_order_id} ` +
          `selections=${dto.selections.length} duplicate=${String(duplicate)}`,
      );

      return { id: row.id, duplicate };
    });
  }
}
