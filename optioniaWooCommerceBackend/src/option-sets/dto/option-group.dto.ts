import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OptionalNotNull, Trimmed } from '../../common/validation/trimmed.decorator';

import { AUTHORING_LIMITS } from '../authoring-limits';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { GroupDisplayType } from '../../common/database/enums';
import { IsStrictBoolean } from '../../common/validation/strict-boolean.decorator';

/**
 * Request shapes for group endpoints.
 *
 * Same conventions as `option-set.dto.ts`: every string is length-bounded, and
 * `forbidNonWhitelisted` rejects unknown fields rather than dropping them.
 */

export class CreateOptionGroupDto {
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A label is required.' })
  @MaxLength(160)
  @ApiProperty({ type: String })
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ type: String })
  description?: string;

  @IsOptional()
  @IsEnum(GroupDisplayType, { message: 'Unknown display type.' })
  @ApiPropertyOptional({ enum: GroupDisplayType })
  displayType?: GroupDisplayType;

  @IsOptional()
  @IsStrictBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isCollapsible?: boolean;

  /** M7.2's escape hatch: created disabled, so a group can be built before it shows. */
  @IsOptional()
  @IsStrictBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;
}

export class UpdateOptionGroupDto {
  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A label cannot be empty.' })
  @MaxLength(160)
  @ApiPropertyOptional({ type: String })
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ type: String })
  description?: string;

  @IsOptional()
  @IsEnum(GroupDisplayType, { message: 'Unknown display type.' })
  @ApiPropertyOptional({ enum: GroupDisplayType })
  displayType?: GroupDisplayType;

  @IsOptional()
  @IsStrictBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isCollapsible?: boolean;

  @IsOptional()
  @IsStrictBoolean()
  @ApiPropertyOptional({ type: Boolean })
  isEnabled?: boolean;
}

export class DuplicateOptionGroupDto {
  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1)
  @MaxLength(160)
  @ApiPropertyOptional({ type: String })
  label?: string;
}

/** One group's new position. */
export class ReorderEntryDto {
  @IsUUID()
  @ApiProperty({ type: String })
  id: string;

  /**
   * Non-negative, and gap-tolerant by convention — clients are expected to use
   * steps (10, 20, 30) so one move does not renumber every sibling.
   */
  @IsInt()
  @Min(0)
  @ApiProperty({ type: Number })
  sortOrder: number;
}

export class ReorderGroupsDto {
  /**
   * Bounded: a set with more than this many groups is not a UI anyone can use,
   * and an unbounded array is a cheap way to make one request do unbounded work.
   *
   * ✏️ **This read `200` — the *options* ceiling — while `groupsPerSet` is 100.**
   * Harmless in practice (the create route refuses the 101st group, so a list of
   * 150 ids could never all exist), but it meant the cap here guarded a number
   * unrelated to what it was bounding. Naming the constant is what made the
   * mismatch visible: two literals that happen to differ look identical.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTHORING_LIMITS.groupsPerSet)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  @ApiProperty({ type: () => [ReorderEntryDto] })
  groups: ReorderEntryDto[];
}

/**
 * Reordering options within a group, or values within an option.
 *
 * The same shape as `ReorderGroupsDto` with a field named for its level, so a
 * client reads what it is ordering rather than inferring it from the path.
 */
export class ReorderOptionsDto {
  @ApiProperty({ type: () => [ReorderEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTHORING_LIMITS.optionsPerGroup)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  options: ReorderEntryDto[];
}

export class ReorderValuesDto {
  @ApiProperty({ type: () => [ReorderEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTHORING_LIMITS.valuesPerOption)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  values: ReorderEntryDto[];
}
