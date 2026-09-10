import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OptionalNotNull, Trimmed } from '../../common/validation/trimmed.decorator';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PriceType } from '../../common/database/enums';

/**
 * Request shapes for value endpoints.
 *
 * **Money is an integer in minor units** (ADR-013) — `1000` is £10.00. A float
 * never reaches this API, and the column's transformer rejects a fractional
 * value as a second line of defence.
 */

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const KEY_MESSAGE =
  'A key may contain lowercase letters, digits, underscores and hyphens, and must start with a letter or digit.';

/**
 * A price bound. Ten million major units — £10,000,000 — is far above any real
 * add-on and far below the point where `bigint` arithmetic surprises anyone.
 */
const MAX_AMOUNT_MINOR = 1_000_000_000;

export class CreateOptionValueDto {
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A value key is required.' })
  @MaxLength(64)
  @Matches(KEY_PATTERN, { message: KEY_MESSAGE })
  @ApiProperty({ type: String })
  valueKey: string;

  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A label is required.' })
  @MaxLength(200)
  @ApiProperty({ type: String })
  label: string;

  @IsOptional()
  @IsEnum(PriceType, { message: 'Unknown price type.' })
  @ApiPropertyOptional({ enum: PriceType })
  priceType?: PriceType;

  /**
   * Integer minor units. Negative is allowed: a value may be a discount.
   */
  @IsOptional()
  @IsInt({ message: 'A price must be an integer in minor units.' })
  @Min(-MAX_AMOUNT_MINOR)
  @Max(MAX_AMOUNT_MINOR)
  @ApiPropertyOptional({ type: Number })
  priceAmountMinor?: number;

  /** Validated against the pricing schema in the service (M7.3). */
  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  priceConfig?: Record<string, unknown>;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'An image URL must be absolute.' })
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  imageUrl?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'A colour must be a six-digit hex value, e.g. #1a2b3c.' })
  @ApiPropertyOptional({ type: String })
  colorHex?: string;

  /**
   * The `<optgroup>` heading this value sits under (M14.3).
   *
   * ⚠️ **Grouping is a rendering detail of `dropdown`, not a type.** Values
   * sharing a label render under one heading; a value with none renders as a
   * plain `<option>`. Only the dropdown template reads it — a radio or swatch
   * with a group label is not an error, it simply has no grouped rendering.
   *
   * Trimmed and length-capped like `label`, which it sits beside visually.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  groupLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  skuSuffix?: string;

  @IsOptional()
  @IsInt()
  @ApiPropertyOptional({ type: Number })
  weightDeltaGrams?: number;

  /** At most one default per option; the service clears any other. */
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;
}

export class UpdateOptionValueDto {
  /**
   * `valueKey` is **not** patchable, for the same reason as an option's `key`:
   * order meta stores it, so a change makes historic orders unreadable.
   */

  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A label cannot be empty.' })
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  label?: string;

  @IsOptional()
  @IsEnum(PriceType, { message: 'Unknown price type.' })
  @ApiPropertyOptional({ enum: PriceType })
  priceType?: PriceType;

  @IsOptional()
  @IsInt({ message: 'A price must be an integer in minor units.' })
  @Min(-MAX_AMOUNT_MINOR)
  @Max(MAX_AMOUNT_MINOR)
  @ApiPropertyOptional({ type: Number })
  priceAmountMinor?: number;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  priceConfig?: Record<string, unknown>;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'An image URL must be absolute.' })
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  imageUrl?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'A colour must be a six-digit hex value, e.g. #1a2b3c.' })
  @ApiPropertyOptional({ type: String })
  colorHex?: string;

  /**
   * The `<optgroup>` heading this value sits under (M14.3).
   *
   * ⚠️ **Grouping is a rendering detail of `dropdown`, not a type.** Values
   * sharing a label render under one heading; a value with none renders as a
   * plain `<option>`. Only the dropdown template reads it — a radio or swatch
   * with a group label is not an error, it simply has no grouped rendering.
   *
   * Trimmed and length-capped like `label`, which it sits beside visually.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  groupLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @ApiPropertyOptional({ type: String })
  skuSuffix?: string;

  @IsOptional()
  @IsInt()
  @ApiPropertyOptional({ type: Number })
  weightDeltaGrams?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;
}

export class DuplicateOptionValueDto {
  /**
   * Key for the copy. Generated as `key-copy` when omitted.
   *
   * The copy lands on the **same option**, where
   * `uq_option_values_option_key` forbids repeating the key.
   */
  @ApiPropertyOptional({ type: String })
  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1)
  @MaxLength(64)
  @Matches(KEY_PATTERN, { message: KEY_MESSAGE })
  valueKey?: string;
}
