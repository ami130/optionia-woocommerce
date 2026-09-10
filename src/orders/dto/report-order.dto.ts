import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The largest number of option lines one order may report.
 *
 * A real order has a handful. The cap is not a business rule but a bound on
 * work: without it one request could ask for an unbounded transaction, and
 * `forbidNonWhitelisted` would not stop it because the array shape is valid.
 */
const MAX_SELECTIONS = 200;

/** One option a customer selected, as a historical fact (M12.7). */
export class ReportOrderSelectionDto {
  @IsString()
  @Length(1, 64)
  @ApiProperty({ type: String })
  option_key: string;

  /**
   * Snapshotted at order time, so a later rename does not rewrite history.
   *
   * The length matches `order_selections.optionLabel`. The plugin truncates to
   * the same bound before sending, because `forbidNonWhitelisted` rejects the
   * **whole** request on one over-long field — and an order report lost to a
   * long label would be invisible.
   */
  @IsString()
  @MaxLength(200)
  @ApiProperty({ type: String })
  option_label: string;

  /**
   * Null for a free-text option.
   *
   * A key exists only where the merchant defined a fixed choice; an engraving
   * has no `valueKey` to report.
   */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({ type: String, nullable: true })
  value_key?: string | null;

  /**
   * ⚠️ **Never the customer's free text.**
   *
   * `order_selections.valueLabel` may hold personal data — an engraving
   * message, a gift note, a name — so the plugin sends the *chosen value's*
   * label (`"Luxury"`) and sends `null` for free-text option types. Phase 25
   * asks how many customers bought engraving and what it earned, not what they
   * wrote, and answering the first without collecting the second keeps
   * ADR-014's erase path a safeguard rather than a routine obligation.
   *
   * Validated at 500 to match the column, because the field is not forbidden —
   * a fixed-choice label is legitimate here. The restraint is the plugin's, and
   * is asserted on that side.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String, nullable: true })
  value_label?: string | null;

  /**
   * What this option added, in integer minor units.
   *
   * Signed: a negative delta is a legitimate discount option, so this is not
   * `@Min(0)`. `Number.MAX_SAFE_INTEGER` is the ceiling both languages share —
   * the plugin refuses beyond it too, so the pair fails identically rather than
   * one truncating what the other accepted.
   */
  @IsInt()
  @ApiProperty({ type: Number })
  price_delta_minor: number;

  /** The config version this line was priced against; makes the delta auditable. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  config_version?: number;
}

/**
 * One completed order, reported for analytics (M12.7).
 *
 * ## Idempotent on `external_order_id`
 *
 * The plugin retries: a response that was sent but never received must not
 * create a second `order_event`. `uq_order_events_external (storeId,
 * externalOrderId)` is the guarantee, and the service upserts against it rather
 * than checking first — two overlapping cron runs would both pass a check.
 */
export class ReportOrderDto {
  /**
   * The WooCommerce order id — the idempotency key.
   *
   * A string rather than a number because it is *WooCommerce's* identifier, not
   * ours, and HPOS installs and order-numbering plugins both produce ids that
   * are not plain integers.
   */
  @IsString()
  @Length(1, 64)
  @ApiProperty({ type: String })
  external_order_id: string;

  /** The order total in integer minor units. */
  @IsInt()
  @Min(0)
  @ApiProperty({ type: Number })
  order_total_minor: number;

  @IsString()
  @Length(3, 3)
  @ApiProperty({ type: String })
  currency: string;

  /** The portion attributable to options — the number this product is sold on. */
  @IsOptional()
  @IsInt()
  @ApiPropertyOptional({ type: Number })
  option_revenue_minor?: number;

  /**
   * When the order was placed, per the **store's** clock.
   *
   * Sent rather than defaulted to arrival time: a queued report can arrive
   * hours late after an outage, and analytics that dated it on arrival would
   * misattribute a whole day's revenue after every incident.
   */
  @IsISO8601()
  @ApiProperty({ type: String, format: 'date-time' })
  occurred_at: string;

  @IsArray()
  @ArrayMaxSize(MAX_SELECTIONS)
  @ValidateNested({ each: true })
  @Type(() => ReportOrderSelectionDto)
  @ApiProperty({ type: [ReportOrderSelectionDto] })
  selections: ReportOrderSelectionDto[];
}
