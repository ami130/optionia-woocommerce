import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { StoreStatus } from '../../common/database/enums';

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
}
