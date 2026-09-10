import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { AUTHORING_LIMITS } from '../authoring-limits';
import { OptionalNotNull } from '../../common/validation/trimmed.decorator';
import { ReorderEntryDto } from './option-group.dto';

import { PresentationalKind } from '../../common/database/enums';

/**
 * A heading, paragraph, divider or rich-text block.
 *
 * 🔴 **Not an option.** M5.4c is explicit: these have no value, no validation, no
 * pricing, and produce no cart or order data. Modelling them as options with
 * `value_kind: none` would force null-checks through five subsystems to save one
 * table.
 *
 * M5.4c gives them exactly two systems — ordering, and conditional visibility
 * ("a rule may hide a heading"). ⚠️ **Only ordering is built.** `RuleTargetType`
 * is `option | group | value` with no `item` member, so nothing can target one
 * today; visibility arrives with Phase 17's rule engine, which depends on this
 * phase. The pricing engine never sees one either way.
 */
/**
 * The kinds a route will actually accept.
 *
 * ⚠️ **`rich_text` is deliberately absent.** M5.4c gates it behind a strict
 * sanitizer at publish *and* at render, because its content is merchant-authored
 * markup rendered on a public storefront — an XSS vector by construction. The
 * enum and the column carry the value so the serializer and the storage layer
 * are ready for it; this list is what stops one being created before the gate
 * exists. Accepting it here and sanitising "later" is how the gap ships.
 */
export const AUTHORABLE_ITEM_KINDS: readonly PresentationalKind[] = [
  PresentationalKind.HEADING,
  PresentationalKind.PARAGRAPH,
  PresentationalKind.DIVIDER,
];

export class CreatePresentationalItemDto {
  @IsIn(AUTHORABLE_ITEM_KINDS as PresentationalKind[], {
    message: `kind must be one of: ${AUTHORABLE_ITEM_KINDS.join(', ')}.`,
  })
  @ApiProperty({ enum: AUTHORABLE_ITEM_KINDS })
  kind!: PresentationalKind;

  /**
   * The text, or the markup for a `rich_text` block.
   *
   * ⚠️ **A divider has none**, and an empty string is the honest way to say so —
   * the alternative is a nullable column whose meaning changes by kind.
   *
   * The 5,000 cap is generous for a paragraph and far short of a page: this is
   * explanatory copy beside a form, not a content management system.
   */
  @IsString()
  @Length(0, 5000)
  @ApiProperty()
  content!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  display?: Record<string, unknown>;
}

/** What a caller may change on an item. */
export class UpdatePresentationalItemDto {
  /**
   * ⚠️ **Not `@Trimmed()`, unlike every other label.** A divider's content is
   * legitimately empty, so trimming here would make `Length(0, …)` the only rule
   * and lose the distinction. `PresentationalItemsService.contentFor()` trims and
   * then applies the per-kind rule — a divider may be blank, a heading may not —
   * which is a decision the DTO cannot make without knowing the kind.
   *
   * `@OptionalNotNull()` still applies: the column is `NOT NULL`, and an explicit
   * `null` reached it as a 500 before this.
   */
  @OptionalNotNull()
  @IsString()
  @Length(0, 5000)
  @ApiPropertyOptional()
  content?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ type: Object })
  display?: Record<string, unknown>;
}

/**
 * Reordering items within a group.
 *
 * The same shape as `ReorderOptionsDto`, with a field named for its level.
 *
 * ✏️ **The cap reads `AUTHORING_LIMITS.itemsPerGroup` rather than repeating the
 * number.** A request can never legitimately reorder more items than a group may
 * hold, and two literals drift the moment one is raised — the sibling DTOs still
 * hardcode 200 and 500 for exactly that reason.
 */
export class ReorderPresentationalItemsDto {
  @ApiProperty({ type: () => [ReorderEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTHORING_LIMITS.itemsPerGroup)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  items: ReorderEntryDto[];
}
