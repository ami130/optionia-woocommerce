import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';

/**
 * Request shapes for option endpoints.
 *
 * **`validation`, `pricing` and `display` are only shape-checked here.** Their
 * contents are validated by the type registry's Zod schemas in the service
 * (M7.3), because what is valid depends on the option's type — `class-validator`
 * cannot express "this object must match the schema `radio` declares".
 *
 * `@IsObject()` still earns its place: it rejects a string or an array before
 * Zod sees it, so the error names the field rather than a parse failure.
 */

/**
 * Keys appear in order meta and in the config document the plugin reads, so
 * they are restricted to a form that survives both: lowercase, digits,
 * underscore and hyphen.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const KEY_MESSAGE =
  'A key may contain lowercase letters, digits, underscores and hyphens, and must start with a letter or digit.';

export class CreateOptionDto {
  @IsString()
  @MinLength(1, { message: 'A key is required.' })
  @MaxLength(64)
  @Matches(KEY_PATTERN, { message: KEY_MESSAGE })
  @ApiProperty({ type: String })
  key: string;

  @IsString()
  @MinLength(1, { message: 'A label is required.' })
  @MaxLength(200)
  @ApiProperty({ type: String })
  label: string;

  /** The option's type. Must be registered — `radio` is the only one at Phase 7. */
  @IsEnum(Presentation, { message: 'Unknown option type.' })
  @ApiProperty({ enum: Presentation })
  presentation: Presentation;

  /**
   * The other two axes are optional and default to what the type declares.
   *
   * Supplying them is allowed so a caller can be explicit, but the validator
   * checks they agree with the registry — a `radio` that claims to be
   * `text`/`many` is a row the evaluator cannot interpret.
   */
  @IsOptional()
  @IsEnum(ValueKind, { message: 'Unknown value kind.' })
  @ApiPropertyOptional({ enum: ValueKind })
  valueKind?: ValueKind;

  @IsOptional()
  @IsEnum(Cardinality, { message: 'Unknown cardinality.' })
  @ApiPropertyOptional({ enum: Cardinality })
  cardinality?: Cardinality;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ type: String })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  placeholder?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  helpText?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  defaultValue?: string;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  validation?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  pricing?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  display?: Record<string, unknown>;
}

export class UpdateOptionDto {
  /**
   * `key` is **not** patchable.
   *
   * M7.2 makes it immutable after first publish because order meta stores
   * `option_key` — a key that can change makes every historic order unreadable.
   * Publish is [7i], so there is no "after first publish" to test against yet;
   * the reading that cannot corrupt an order is the one shipped.
   */

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'A label cannot be empty.' })
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ type: String })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({ type: String })
  placeholder?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  helpText?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  defaultValue?: string;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  validation?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  pricing?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  display?: Record<string, unknown>;
}

export class DuplicateOptionDto {
  /**
   * Key for the copy. Generated as `key-copy` when omitted.
   *
   * Unlike a duplicated group, the copy lands in the **same** group as its
   * source, where `uq_options_group_key` forbids repeating the key.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(KEY_PATTERN, { message: KEY_MESSAGE })
  @ApiPropertyOptional({ type: String })
  key?: string;
}
