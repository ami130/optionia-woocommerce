import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

import { AUTHORING_LIMITS } from '../authoring-limits';
import { OptionalNotNull } from '../../common/validation/trimmed.decorator';
import { ReorderEntryDto } from './option-group.dto';

import { RuleAction, RuleMatchType, RuleTargetType } from '../../common/database/enums';
import { MAX_CONDITIONS_PER_RULE } from '../types/rule-condition.schema';

/**
 * A conditional rule: IF <conditions, matched ALL|ANY> THEN <action> ON <target>.
 *
 * ## Why `conditions` is `unknown[]` here rather than a nested DTO
 *
 * The shape is a **discriminated union on `operator`** — five branches, each with
 * a different operand type — and `ruleConditionsSchema` already expresses it,
 * exactly once, in the form both the API and (via the shared fixture) the two
 * evaluators agree on. A second expression as class-validator decorators would be
 * two descriptions of one shape, free to drift; `OptionTypeValidator` already
 * settled that argument for `pricing` and `validation`.
 *
 * So this layer asserts only what class-validator can see cheaply — that it is a
 * non-empty array — and the service runs the Zod schema for content.
 *
 * 🔴 **`@ArrayNotEmpty()` is load-bearing, not decoration.** The Zod bridge
 * (`OptionTypeValidator.check`) returns **no errors for `undefined` or `null`**,
 * deliberately: a database row carrying `validation: null` must not fail
 * validation, and all 45 seeded options did before that rule existed. A rule
 * POSTed with no `conditions` at all would therefore pass every schema check and
 * store a rule with an empty condition list — **a rule that always fires**. Only
 * the DTO can require the field, because only the DTO sees its absence.
 */
export class CreateOptionRuleDto {
  @IsIn(Object.values(RuleTargetType), {
    message: `targetType must be one of: ${Object.values(RuleTargetType).join(', ')}.`,
  })
  @ApiProperty({ enum: Object.values(RuleTargetType) })
  targetType!: RuleTargetType;

  /**
   * The group, option or value this rule acts on.
   *
   * ⚠️ **Shape only.** Whether the id names a row **in this option set** is a
   * cross-object question needing the set loaded, and it belongs with the
   * publish-time check that also detects cycles (M17.3) — the same boundary
   * `ruleConditionsSchema` draws for each condition's `optionId`. Validating it
   * in two places would be two answers to one question.
   *
   * 🔴 **`@IsUUID()`, not `@Length(1, 36)`.** Measured before this: a rule with
   * `targetId: 'not-a-uuid'` was **accepted and stored**. Every comparable id in
   * this API — `storeId`, `ReorderEntryDto.id`, all seven of this controller's
   * path params — is UUID-validated, so the create route was looser about ids
   * than the reorder route beside it.
   *
   * ⚠️ **It is not cosmetic, because a malformed id is permanent.** It can never
   * match a real row, so the rule is inert — and `CascadeService` matches
   * `targetType` **and** `targetId` together, so no delete will ever sweep it
   * into `TARGET_DELETED`. The mechanism that exists to tell a merchant "this
   * rule lost its target" cannot fire for a target that never existed.
   */
  @IsUUID()
  @ApiProperty({ type: String })
  targetId!: string;

  @IsIn(Object.values(RuleAction), {
    message: `action must be one of: ${Object.values(RuleAction).join(', ')}.`,
  })
  @ApiProperty({ enum: Object.values(RuleAction) })
  action!: RuleAction;

  @IsIn(Object.values(RuleMatchType), {
    message: `matchType must be one of: ${Object.values(RuleMatchType).join(', ')}.`,
  })
  @ApiProperty({ enum: Object.values(RuleMatchType) })
  matchType!: RuleMatchType;

  /**
   * 🔴 **`@Type(() => Object)` is load-bearing, and its absence is silent.**
   *
   * `main.ts` sets `enableImplicitConversion: true`. With it, `class-transformer`
   * reads the *design-time* element type of an array — and for `unknown[]` it
   * infers `Array`, then coerces every element into one. Measured:
   *
   * ```text
   * in   [{ optionId: 'o1', operator: 'equals', value: 'a' }]
   * out  [[]]
   * ```
   *
   * Every condition is replaced by an empty array **before any validator runs**,
   * so the schema never sees what the merchant sent. `@Type(() => Object)` names
   * the element type explicitly and the payload survives intact.
   *
   * ⚠️ **The sibling DTOs do not need this and that is why it was missed.**
   * `validation` and `pricing` are `Record<string, unknown>` — an object, which
   * implicit conversion leaves alone. `conditions` is the first *array of
   * objects* in this API, so it is the first field this reaches.
   */
  @IsArray()
  @ArrayNotEmpty({ message: 'A rule needs at least one condition, or it always fires.' })
  @ArrayMaxSize(MAX_CONDITIONS_PER_RULE)
  @Type(() => Object)
  @ApiProperty({ type: Object, isArray: true })
  conditions!: unknown[];

  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  sortOrder?: number;
}

/**
 * What a caller may change on a rule.
 *
 * ⚠️ **`optionSetId` is absent, deliberately.** Moving a rule between sets would
 * carry `targetId` and every condition's `optionId` into a set where they name
 * nothing — the same defect `copyRulesInto` exists to prevent during
 * duplication, arriving through a different door. A rule belongs to the set it
 * was created in; the way to have it elsewhere is to create it there.
 *
 * `isEnabled` and `disabledReason` are also absent: see `OptionRulesService`.
 */
export class UpdateOptionRuleDto {
  @OptionalNotNull()
  @IsIn(Object.values(RuleTargetType))
  @ApiPropertyOptional({ enum: Object.values(RuleTargetType) })
  targetType?: RuleTargetType;

  /** See the create DTO: `@IsUUID()`, because a malformed id is permanently inert. */
  @OptionalNotNull()
  @IsUUID()
  @ApiPropertyOptional({ type: String })
  targetId?: string;

  @OptionalNotNull()
  @IsIn(Object.values(RuleAction))
  @ApiPropertyOptional({ enum: Object.values(RuleAction) })
  action?: RuleAction;

  @OptionalNotNull()
  @IsIn(Object.values(RuleMatchType))
  @ApiPropertyOptional({ enum: Object.values(RuleMatchType) })
  matchType?: RuleMatchType;

  /**
   * ⚠️ **`@ArrayNotEmpty()` again, for the reason it is on the create DTO.**
   * `PATCH { conditions: [] }` would otherwise store a rule that always fires,
   * and the Zod bridge cannot refuse what it never sees.
   */
  @OptionalNotNull()
  @IsArray()
  @ArrayNotEmpty({ message: 'A rule needs at least one condition, or it always fires.' })
  @ArrayMaxSize(MAX_CONDITIONS_PER_RULE)
  /* See the create DTO: without this, implicit conversion rewrites every
   * condition to `[]` before a validator runs. */
  @Type(() => Object)
  @ApiPropertyOptional({ type: Object, isArray: true })
  conditions?: unknown[];

  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  sortOrder?: number;
}

/**
 * Reordering rules within a set.
 *
 * The cap reads `AUTHORING_LIMITS.rulesPerSet` rather than repeating the number:
 * a request can never legitimately reorder more rules than a set may hold, and
 * two literals drift the moment one is raised.
 */
export class ReorderOptionRulesDto {
  @ApiProperty({ type: () => [ReorderEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTHORING_LIMITS.rulesPerSet)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  rules: ReorderEntryDto[];
}
