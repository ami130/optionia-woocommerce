import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ArrayMaxSize, ArrayNotEmpty, IsString, Length } from 'class-validator';

/**
 * The most products one request may assign.
 *
 * A picker's "select all" on a page, with room to spare. The cap bounds the work
 * a single request can ask for; a merchant assigning a whole catalogue does it a
 * page at a time, which is also how they can see what they did.
 */
const MAX_TARGETS = 100;

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
