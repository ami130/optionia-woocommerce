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
   * Which option set this choice came from (F150, M25.3).
   *
   * 🔴 **Optional, and null for every order placed before the plugin update.**
   * The order meta carrying it did not exist, and nothing can infer it: the
   * older `_optionia_option_set_id` is a flat list of the sets a *line* touched,
   * which cannot say which option belongs to which — the whole reason the
   * per-option key was added.
   *
   * ⚠️ **So "revenue per option set" has a boundary date**, and analytics must
   * present it as such rather than reporting older orders as belonging to no
   * set. The same discontinuity F146's quantity fix created, on a second axis.
   *
   * 36 characters: a UUID. Mirrored in `OrderPayload::MAX_SET_ID`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(36)
  @ApiPropertyOptional({ maxLength: 36, nullable: true })
  option_set_id?: string | null;

  /**
   * Which product this choice was bought against (F151, M25.4).
   *
   * 🔴 **Optional, and null for every order placed before the plugin update**,
   * on exactly the same terms as `option_set_id`. An order already reported
   * carries no record of which line item each selection came from, so there is
   * nothing to infer it from and nothing to backfill.
   *
   * ⚠️ **A string, though WooCommerce's ids are integers.** It identifies a row
   * in a database this system does not own; arithmetic on it would be
   * meaningless, and a variable product reports a *variation* id rather than
   * the parent's. Accepting it as text means a merchant migrating stores cannot
   * produce a value this rejects.
   *
   * 64 characters, mirrored in `OrderPayload::MAX_PRODUCT_REF`. Generous
   * because the cost of being wrong is a 400 for the **whole order**, which
   * `OrderPayload` treats as permanent — so an over-tight bound here silently
   * drops a merchant's revenue rather than truncating one field.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @ApiPropertyOptional({ maxLength: 64, nullable: true })
  product_ref?: string | null;

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
