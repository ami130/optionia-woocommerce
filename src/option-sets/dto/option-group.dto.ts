import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

/**
 * Request shapes for group endpoints.
 *
 * Same conventions as `option-set.dto.ts`: every string is length-bounded, and
 * `forbidNonWhitelisted` rejects unknown fields rather than dropping them.
 */

export class CreateOptionGroupDto {
  @IsString()
  @MinLength(1, { message: 'A label is required.' })
  @MaxLength(160)
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(GroupDisplayType, { message: 'Unknown display type.' })
  displayType?: GroupDisplayType;

  @IsOptional()
  @IsBoolean()
  isCollapsible?: boolean;

  /** M7.2's escape hatch: created disabled, so a group can be built before it shows. */
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class UpdateOptionGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'A label cannot be empty.' })
  @MaxLength(160)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(GroupDisplayType, { message: 'Unknown display type.' })
  displayType?: GroupDisplayType;

  @IsOptional()
  @IsBoolean()
  isCollapsible?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class DuplicateOptionGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  label?: string;
}

/** One group's new position. */
export class ReorderEntryDto {
  @IsUUID()
  id: string;

  /**
   * Non-negative, and gap-tolerant by convention — clients are expected to use
   * steps (10, 20, 30) so one move does not renumber every sibling.
   */
  @IsInt()
  @Min(0)
  sortOrder: number;
}

export class ReorderGroupsDto {
  /**
   * Bounded: a set with more than this many groups is not a UI anyone can use,
   * and an unbounded array is a cheap way to make one request do unbounded work.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  groups: ReorderEntryDto[];
}
