import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { IsStrictBoolean } from '../../common/validation/strict-boolean.decorator';

/**
 * The most external ids one reconcile page may carry.
 *
 * 🔴 **Derived from the body limit, and checked at the column's full width.**
 * `externalId` is `varchar(64)`, so 10,000 ids at their maximum length is
 * **664 kB** against the 1 MB limit (ADR-072) — measured, not estimated.
 * Realistic numeric ids are 77 kB, so the cap is bounded by the pathological
 * case rather than the ordinary one.
 *
 * 📌 **Ids rather than products is the whole economy of this endpoint.** A
 * 100k catalogue is **10** requests here against **400** for a full re-push at
 * 250 products a batch.
 */
export const MAX_IDS_PER_PAGE = 10_000;

/**
 * One page of the store's external product ids (M19.3).
 *
 * 🔴 **The store is the authority on what exists** (ADR-067, ADR-075). The
 * cloud cannot detect a product it has never heard of, so reconciliation is
 * driven from the plugin: it sends what it has, and the cloud reports what it
 * holds that the store did not mention.
 */
export class ReconcileProductsDto {
  /**
   * External ids the store holds, in **string** ascending order.
   *
   * ⚠️ **Ordering is load-bearing, not tidiness.** The cloud deletes only ids
   * **within the range a manifest covered**, and it knows that range from the
   * page's first and last id. Unordered pages would make the range meaningless.
   *
   * 🔴 **String order, because `externalId` is `varchar` and MySQL compares it
   * as one.** The two orderings genuinely differ: numerically `2 < 9 < 10 <
   * 100`, but as strings `"10" < "100" < "2" < "9"`. A plugin paging
   * numerically — which is what `wc_get_products()` does with `orderby => ID` —
   * would send `range_start = "2"`, and the mirror's rows `10` and `100` sort
   * **below** it as strings, so they fall outside every range and are **never
   * examined**.
   *
   * 📌 **A leak, not a loss.** Unexamined rows are never wrongly deleted — the
   * cloud only removes ids it saw *inside* a range and the manifest did not
   * claim. But a product deleted upstream would survive every sweep, which is
   * the defect reconciliation exists to close.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_IDS_PER_PAGE)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  @ApiProperty({ type: [String] })
  external_ids: string[];

  /**
   * Whether this page completes the manifest.
   *
   * 🔴 **The flag that separates a safe sweep from a deleted catalogue.**
   * Without it, absence from a page would read as "the store no longer has
   * this" — and during an ordinary paged sweep the cloud would see every id
   * outside the current page as gone. Modelled: a mirror of 40,000 products and
   * a page of 250 leaves **39,750 valid products deleted**.
   *
   * So deletion is considered **only** when this is true, and even then only
   * for ids inside the range the manifest covered.
   *
   * ✏️ **This field existed in `IngestProductsDto` and was removed in 19-2**
   * for having no reader — logged and consumed by nothing. It returns here
   * because it now has one, which is the difference between a wire field and a
   * decorative one.
   */
  @IsOptional()
  @IsStrictBoolean()
  @ApiPropertyOptional({ type: Boolean })
  is_final?: boolean;

  /**
   * The lowest id this whole sweep covers, in the same string order.
   *
   * Carried on every page because a deletion decision spans them: the cloud
   * must know the manifest's **floor** when the final page arrives, and the
   * final page alone cannot say what the first one started from.
   *
   */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({ type: String })
  range_start?: string;
}
