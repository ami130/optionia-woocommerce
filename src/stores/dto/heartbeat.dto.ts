import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { StoreStatus } from '../../common/database/enums';

/**
 * The largest storage figure a store may report, in bytes.
 *
 * One terabyte: roughly forty times the largest plan (business, 25 000 MB) and
 * four orders of magnitude below `Number.MAX_SAFE_INTEGER`, so a real store can
 * never reach it and a corrupt one cannot overflow the column.
 */
const STORAGE_BYTES_CEILING = 1024 ** 4;

/**
 * Bring a reported storage figure into range instead of refusing it.
 *
 * A non-numeric value is passed through untouched so the validators below still
 * describe what was wrong — clamping a string to a number here would turn a
 * malformed payload into a plausible one.
 *
 * @param value Whatever the plugin sent.
 */
function clampStorageBytes(value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }

  return Math.min(Math.max(0, Math.trunc(value)), STORAGE_BYTES_CEILING);
}

/** The daily ping a connected plugin sends (M8.5). */
export class HeartbeatDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  plugin_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  wp_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  wc_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @ApiPropertyOptional({ type: String })
  php_version?: string;

  /**
   * The plugin's own view of its connection.
   *
   * **All five states are accepted**, including the ones a healthy plugin would
   * never report. It can only truthfully observe `connected` or `error` — it
   * cannot know it was revoked, having received a `401` — so narrowing this
   * looks tighter and is worse: it would reject the anomalous report at
   * validation and lose the exact signal reconciliation exists to capture. A
   * `400` says nothing; a recorded mismatch says a site is confused.
   */
  @IsOptional()
  @IsEnum(StoreStatus, { message: 'Unknown connection state.' })
  @ApiPropertyOptional({ enum: Object.values(StoreStatus) })
  connection_state?: StoreStatus;

  /** The configuration version the plugin currently serves. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  config_version?: number;

  /** How stale the plugin's cached configuration is. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  cache_age_seconds?: number;

  /**
   * The highest document shape this plugin build understands (M9.5).
   *
   * Reported so the cloud can see a store that has stopped accepting documents.
   * `Config\Repository` refuses a `schema_version` above what it knows and keeps
   * its previous copy — the right behaviour, and completely silent: the store
   * goes on serving old configuration while every other signal says it is
   * healthy. The plugin cannot tell the merchant to update if the cloud never
   * learns it needs to.
   *
   * Separate from `config_version`, which is *content*. A store can be current
   * on content and unable to read the next shape, or behind on content while
   * understanding the shape perfectly.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  supported_schema_version?: number;

  /**
   * Whether the plugin last refused a document it could not read (M9.5).
   *
   * `supported_schema_version` says what it *can* read; this says whether that
   * limit has actually bitten. A store reporting `true` is serving stale
   * configuration right now, which is an operations signal rather than a
   * capability one — and the difference decides whether anyone needs to act.
   */
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  schema_refused?: boolean;

  /**
   * Bytes this store is holding in customer uploads (M15.6).
   *
   * Carried on the heartbeat rather than posted to an endpoint of its own
   * because usage is a **level, not an event**. `POST /store/orders` has a queue
   * and retry semantics because a missed order is lost; a missed storage figure
   * is simply superseded by the next heartbeat.
   *
   * ⚠️ **Bytes, not megabytes.** The plan limit is written `file_storage_mb`,
   * but rounding at the edge would make every store under half a megabyte report
   * zero, and the conversion belongs where the limit is compared — not in a
   * number thirty thousand stores send. `bigint` on `usage_records.value` holds
   * this comfortably.
   *
   * The store's tenant comes from the credential, so a tenant with several
   * stores is summed here rather than being asked to sum itself.
   *
   * 🔴 **Clamped, never rejected.** An earlier version enforced the ceiling with
   * `@Max`, which turned one bad number into a **400 for the whole heartbeat** —
   * losing the connection state, the version report and the schema signal daily
   * until the figure came back in range. A metric is the least important thing in
   * this payload and must never be able to take the rest of it down.
   *
   * ⚠️ **Bounded, and not as an anti-abuse control.** Only a store's own
   * credential can send this, and a merchant inflating their own figure only
   * reaches their own limit sooner — the abusable direction is *under*-reporting,
   * which no ceiling prevents. The bound exists so a **plugin bug** cannot brick
   * a store: a corrupt total above `bigint` would make the write fail and turn
   * every heartbeat into a 500, losing the connection state, the version report
   * and the schema signal to collect a number that is merely useful.
   */
  @IsOptional()
  @Transform(({ value }) => clampStorageBytes(value))
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  storage_bytes?: number;
}
