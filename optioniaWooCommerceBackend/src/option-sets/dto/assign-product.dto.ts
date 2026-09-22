import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  ArrayNotEmpty,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { AssignmentTargetType } from '../../common/database/enums';

/**
 * The most products one request may assign.
 *
 * A picker's "select all" on a page, with room to spare. The cap bounds the work
 * a single request can ask for; a merchant assigning a whole catalogue does it a
 * page at a time, which is also how they can see what they did.
 */
export const MAX_TARGETS = 100;

/**
 * Assign an option set to one or more products (M13.6).
 *
 * ## Only `MANUAL`, and `mode` is not a field
 *
 * The caller does not choose the mode: this endpoint writes `manual` and
 * `product`, because that is the assignment a picker makes. `ALL` is a property
 * of the set rather than a product choice, and `CONDITIONAL` needs a rule tree
 * that [Phase 17](../../developePlan.md) has not built.
 *
 * Accepting `mode` from the client would mean trusting it to send the value the
 * storefront requires — and a missing or wrong one does not fail loudly. The
 * plugin treats an unrecognised mode as neither `all` nor `manual`, **skips the
 * assignment entirely** and counts it as deferred, so the option simply never
 * renders with a skip counter as the only trace.
 */
export class AssignProductsDto {
  /**
   * WooCommerce product ids — `store_products.externalId`, not our row id.
   *
   * The storefront resolves assignments against the ids WooCommerce uses on the
   * merchant's own site, so that is what `targetRef` must hold.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TARGETS)
  @IsString({ each: true })
  @Length(1, 255, { each: true })
  @ApiProperty({ type: [String] })
  externalProductIds!: string[];
}

/**
 * The target types a merchant may assign to (M19.1').
 *
 * 🔴 **Four of the enum's five.** `product`, `category`, `tag` and `attribute`
 * are each a single reference the `targetRef` column already holds and the
 * `ix_assignments_target` index already covers. `price_range` is here too: a
 * band is still one string, parsed by whatever resolves it.
 *
 * ⚠️ **`CONDITIONAL` is a MODE, not a target type, and stays deferred**
 * (ADR-069). Its `conditions` column exists with **no schema, no validator and
 * no evaluator** anywhere — it is a feature to design, not a value to permit.
 * Listing it here would let a merchant author a row nothing can read.
 *
 * 📌 **Named explicitly rather than taken from the enum.** `AssignmentTargetType`
 * is the *storage* vocabulary; this is the *authoring* one, and they are allowed
 * to differ — the same separation `AUTHORABLE_TYPES` keeps from the option type
 * registry, for the reason recorded there: a type the API stores is not
 * automatically a type a merchant can reach.
 */
export const ASSIGNABLE_TARGET_TYPES = [
  AssignmentTargetType.PRODUCT,
  AssignmentTargetType.CATEGORY,
  AssignmentTargetType.TAG,
  AssignmentTargetType.ATTRIBUTE,
  AssignmentTargetType.PRICE_RANGE,
] as const;

/**
 * One thing an option set is assigned to.
 *
 * ⚠️ **`mode` is still not a field**, for the reason the product DTO above
 * records: the plugin treats an unrecognised mode as neither `all` nor `manual`,
 * **skips the assignment entirely**, and counts it as deferred — so a wrong
 * value does not fail loudly, it renders nothing with a skip counter as the only
 * trace. The server decides the mode from the target type.
 */
export class AssignmentTargetDto {
  /*
   * 🔴 **Validated against the AUTHORING list, not the enum.** `@IsEnum(
   * AssignmentTargetType)` would admit every value the column can store,
   * including any the docblock above says is not authorable — and the
   * `@ApiProperty` would then document a narrower set than the validator
   * accepts. That gap is exactly how `CONDITIONAL` would reach the database
   * with no evaluator to read it. `@IsIn` keeps the two in step by construction:
   * widening the authoring list is the only way to widen what is accepted.
   *
   * 📌 **Equivalent today, deliberately.** `AssignmentTargetType` holds exactly
   * the five values `ASSIGNABLE_TARGET_TYPES` lists, so swapping this for
   * `@IsIn(Object.values(AssignmentTargetType))` changes no behaviour and no
   * test can kill that mutant — it was tried. The narrower list earns its place
   * as the seam, not as a filter: the day a type is stored but not authorable,
   * this is already the line that has to move, and the `@ApiProperty` below
   * already documents the authoring list rather than the enum.
   */
  @IsIn(ASSIGNABLE_TARGET_TYPES as readonly string[], {
    message: 'Unknown assignment target type.',
  })
  @ApiProperty({ enum: ASSIGNABLE_TARGET_TYPES })
  targetType!: AssignmentTargetType;

  /**
   * What the target names — a product id, a category slug, a price band.
   *
   * 🔴 **Always the reference the STOREFRONT resolves against**, not our row id.
   * For a product that is `store_products.externalId`, because the plugin
   * matches the ids WooCommerce uses on the merchant's own site; for a category
   * it is the term the plugin will pass to `has_term()`.
   */
  @IsString()
  @Length(1, 255)
  @ApiProperty({ type: String })
  targetRef!: string;
}

/**
 * Assign an option set to one or more targets (M19.1').
 *
 * 🔴 **This is what `AssignProductsDto` could not express.** Three of five
 * target types were unreachable end to end — `assignments.service.ts` hardcoded
 * `PRODUCT`, and this file had no field to carry anything else. The enum, the
 * column and the index all existed; only the authoring path did not.
 */
export class AssignTargetsDto {
  /*
   * ⚠️ **`@ValidateNested` and `@Type` together, or neither works.** Without
   * the transform each entry arrives as a plain object and the nested rules
   * never run — the array is validated and its contents are not, which is the
   * shape a bad `targetType` would slip through.
   */
  /*
   * 🔴 **Optional here, required by the time the service sees it.** A legacy
   * body carries no `targets` key at all, and `class-transformer` fixes an
   * instance's properties from the keys the source object has — a per-property
   * `@Transform` on a key that is absent never runs, and one that writes the
   * key from a sibling runs too late to be copied. Both were tried; both left
   * `targets` undefined. So the conversion happens in the controller, which can
   * see the whole body, and the validator below accepts a body that omits this
   * only when `externalProductIds` supplies it — enforced by `@ValidateIf`.
   */
  @ValidateIf((dto: AssignTargetsDto) => dto.externalProductIds === undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TARGETS)
  @ValidateNested({ each: true })
  @Type(() => AssignmentTargetDto)
  @ApiProperty({ type: [AssignmentTargetDto], required: false })
  targets!: AssignmentTargetDto[];

  /**
   * The M13.6 request shape, still accepted (M19.1').
   *
   * ⚠️ **Declared so the validation pipe does not strip it**, and read by the
   * controller, which converts it into `targets`. Without the declaration
   * `forbidNonWhitelisted` would reject a request the deployed dashboard still
   * sends, naming a field the caller never wrote.
   *
   * @deprecated Send `targets` instead; this cannot express a non-product
   * assignment.
   */
  @IsOptional()
  @IsArray()
  /*
   * 🔴 **Empty is rejected, not silently accepted.** `@ValidateIf` above skips
   * `targets` whenever this field is *defined*, so `{ externalProductIds: [] }`
   * would otherwise pass every validator and reach the service with nothing to
   * assign — a 200 that assigned nothing, which is precisely the silent
   * no-op an assignment write must never be.
   */
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TARGETS)
  @IsString({ each: true })
  @Length(1, 255, { each: true })
  @ApiPropertyOptional({ type: [String], deprecated: true })
  externalProductIds?: string[];
}

/**
 * Unassign an option set from one or more targets (M19.5).
 *
 * 🔴 **A POST, not a DELETE with a body.** `DELETE /:targetRef` stays exactly
 * as it is — it is the URL the shipped dashboard calls, and ADR precedent here
 * is that changing a live URL 404s deployed clients. A request body on DELETE
 * is also permitted-but-discouraged by RFC 9110 and is dropped by some proxies
 * and fetch implementations, so a bulk removal that silently removed *nothing*
 * would be indistinguishable from one that worked.
 *
 * ⚠️ **Targets are `(type, ref)` PAIRS, never bare references.** `targetRef` is
 * unique only within a type: category `12` and product `12` are different rows,
 * and the single unassign's own docblock records what matching on the reference
 * alone once did — *"removing a category assignment whose ref happened to be a
 * product id would have deleted the product's row instead"*.
 */
export class UnassignTargetsDto {
  /*
   * `@ValidateNested` with `@Type`, or the entries are never checked — the same
   * pairing `AssignTargetsDto` documents above.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TARGETS)
  @ValidateNested({ each: true })
  @Type(() => AssignmentTargetDto)
  @ApiProperty({ type: [AssignmentTargetDto] })
  targets!: AssignmentTargetDto[];
}
