import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  registerDecorator,
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A calendar date that exists, not merely one shaped like a date.
 *
 * 🔴 **Written after `2026-13-45` produced a 500.** The format check passes it,
 * MySQL rejects it, and the merchant's plugin retries a request that can never
 * succeed. Rolling over — treating 31 February as 3 March, which is what
 * `Date` does — would be worse: it stores a day the customer never browsed.
 */
function IsRealDate() {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isRealDate',
      target: object.constructor,
      propertyName,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') {
            return false;
          }

          const parsed = new Date(`${value}T00:00:00.000Z`);

          if (Number.isNaN(parsed.getTime())) {
            return false;
          }

          /*
           * The round trip is the check: `2026-02-31` parses to 3 March, and
           * only comparing the formatted result back to the input catches it.
           */
          return parsed.toISOString().slice(0, 10) === value;
        },
        defaultMessage(): string {
          return 'day must be a real calendar date, e.g. 2026-09-29';
        },
      },
    });
  };
}

/** One option's view count for one day. */
export class ViewCountDto {
  @ApiProperty({ maxLength: 36, description: 'The option set the option belongs to.' })
  @IsString()
  @Length(1, 36)
  option_set_id: string;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @Length(1, 64)
  option_key: string;

  /**
   * The store's own date, not UTC's.
   *
   * 🔴 **The shape is not enough, and a test proved it.** `2026-13-45` matches
   * `\d{4}-\d{2}-\d{2}` perfectly and is not a date: MySQL refuses month 13,
   * so it reached the driver and came back a **500**. A merchant's plugin sees a
   * server error, treats it as transient and retries for ever — the worst of
   * both, because the request can never succeed and never stops.
   *
   * ⚠️ **`new Date()` alone would NOT have caught it either.**
   * `new Date('2026-13-45')` is `Invalid Date` rather than a throw, and
   * `new Date('2026-02-31')` silently becomes 3 March — so the check
   * round-trips the parsed date back to a string and insists it is unchanged.
   */
  @ApiProperty({ example: '2026-09-29', description: 'ISO date in the store’s own timezone.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be an ISO date, e.g. 2026-09-29' })
  @IsRealDate()
  day: string;

  /**
   * Views accumulated since the last successful report — a DELTA, not a total.
   *
   * 🔴 **The whole idempotency story rests on this word.** The cloud adds this
   * to what it holds, so the plugin must clear its counter only after a 2xx. A
   * plugin sending a running total instead would multiply every merchant's
   * figures by the number of drains.
   *
   * ⚠️ **Bounded at a million.** A single option cannot honestly be seen a
   * million times between two cron runs, so a larger number is a bug or an
   * attack, and silently adding it would corrupt a merchant's analytics with no
   * way to tell which day was wrong.
   */
  @ApiProperty({ minimum: 1, maximum: 1_000_000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  views: number;
}

/**
 * A batch of view counts from one store (M25.1).
 *
 * 🔴 **Batched because a view is every product page load.** One request per view
 * would make this the most-called endpoint in the system by an order of
 * magnitude, driven by a merchant's traffic rather than their sales. The plugin
 * aggregates locally and drains on cron, which is the same shape
 * `OrderReporter` uses and the reason Phase 25's exit criterion still holds.
 */
export class ReportViewsDto {
  /**
   * ⚠️ **Capped at 500 rows.** A store with more than 500 (option, day) pairs
   * pending has been offline for weeks, and accepting an unbounded array would
   * let one request hold a connection open for as long as it liked. The plugin
   * sends the rest on the next drain.
   */
  @ApiProperty({ type: [ViewCountDto], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ViewCountDto)
  views: ViewCountDto[];
}
