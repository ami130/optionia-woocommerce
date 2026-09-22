import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The largest number of products one push may carry.
 *
 * ✏️ **This number is a throughput choice bounded by a body limit — not, as an
 * earlier draft claimed, "derived" from it.** That draft put the worst-case
 * product at ~1.8 kB and concluded 250 was ~442 kB. It had **forgotten the
 * taxonomy arrays**: `categories` and `tags` each allow 50 entries of 200
 * characters, so the true worst case is **~22 kB** and 250 of them is **5.26
 * MB** — five times the limit. Measured, not estimated.
 *
 * **A cap safe in every case is too slow to ship.** At the absolute worst case
 * only **47** products fit in 1 MB, and 40 per batch would take **26 days** for
 * a 100k catalogue on the plugin's 900-second schedule. 250 takes **4.2 days**.
 *
 * 🔴 **So the limit is enforced by the body limit, and the plugin adapts.** A
 * batch that exceeds 1 MB answers `413 PAYLOAD_TOO_LARGE` (ADR-072) — verified
 * against a running server — and the pusher halves its batch and retries.
 * Worst case that converges in **three** halvings (250 → 31); a realistic store
 * never retries at all, because 50 *real* slugs make a 2.3 kB product and 250 of
 * those is 558 kB.
 *
 * ⚠️ **`OrderReporter::BATCH_SIZE = 10` is NOT the precedent.** Its docblock
 * justifies ten as *"ten reports at a second each"* — wall-clock for **ten HTTP
 * requests**, because that drain sends one request per order. A catalogue push
 * sends **one request per batch**, so neither the number nor its reasoning
 * transfers: at ten per run a 100k catalogue would take **104 days**.
 */
export const MAX_PRODUCTS_PER_PUSH = 250;

/**
 * One product as the store sees it (M19.1).
 *
 * `snake_case` on the wire, like `ReportOrderDto` and the config document: this
 * is a store-facing payload built by PHP, and the storage side is `camelCase`
 * by construction.
 *
 * ⚠️ **Every length matches its column.** A value longer than the column would
 * pass validation and fail at the driver as a `500` — the caller's mistake
 * reported as ours, which is the shape ADR-072 has just finished removing.
 */
export class IngestProductDto {
  /**
   * The WooCommerce product id.
   *
   * 🔴 **A string, though WooCommerce's is an integer.** `targetRef` on an
   * assignment is `varchar`, and the plugin compares the two; making this an
   * integer here would put the conversion in a different place from the
   * comparison, which is how `20` and `"20"` stop matching.
   */
  @IsString()
  @Length(1, 64)
  @ApiProperty({ type: String })
  external_id: string;

  @IsString()
  @Length(1, 255)
  @ApiProperty({ type: String })
  name: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  @ApiPropertyOptional({ type: String, nullable: true })
  sku?: string | null;

  /** `simple`, `variable`, `grouped` — WooCommerce's vocabulary, not ours. */
  @IsString()
  @Length(1, 20)
  @ApiProperty({ type: String })
  type: string;

  /**
   * The price in minor units, or null where there is no single price.
   *
   * ⚠️ **Null is meaningful, not missing.** A variable product genuinely has no
   * one price, and the picker prints `—` for it. Defaulting to `0` would show a
   * free product where the merchant has a price range.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number, nullable: true })
  price_minor?: number | null;

  /** `publish`, `draft`, `private` — what the storefront does with it. */
  @IsString()
  @Length(1, 20)
  @ApiProperty({ type: String })
  status: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  @ApiPropertyOptional({ type: String, nullable: true })
  permalink?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  @ApiPropertyOptional({ type: String, nullable: true })
  image_url?: string | null;

  /**
   * The product's category slugs.
   *
   * 📌 **Slugs, because that is what an assignment targets.** ADR-068 resolves
   * taxonomy assignments **in the plugin**, against the terms WordPress holds;
   * the cloud stores these so the picker can eventually name them, not so it
   * can resolve them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  @ApiPropertyOptional({ type: [String], nullable: true })
  categories?: string[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  @ApiPropertyOptional({ type: [String], nullable: true })
  tags?: string[] | null;

  /**
   * When the product last changed upstream.
   *
   * Carried so M19.3's reconciliation can tell a stale mirror row from a
   * current one without re-reading the whole catalogue.
   */
  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ type: String, nullable: true })
  external_updated_at?: string | null;
}

/**
 * One batch of a catalogue push (M19.1).
 *
 * 🔴 **The store pushes; the cloud never pulls** (ADR-067). A pull would need
 * the cloud to hold WooCommerce credentials for every tenant, which AC8
 * forbids: *"every plugin installation is treated as potentially hostile"*.
 * The plugin reads its own catalogue with `wc_get_products()` — in-process, no
 * credentials — and posts batches here.
 */
export class IngestProductsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PRODUCTS_PER_PUSH)
  @ValidateNested({ each: true })
  @Type(() => IngestProductDto)
  @ApiProperty({ type: [IngestProductDto] })
  products: IngestProductDto[];

  /*
   * ✏️ **There was an `is_final` flag here, and it was removed.** Nothing
   * consumed it: the service only logged it, no test sent it, and neither
   * consumer this phase builds needs it — M19.3's reconciliation is a
   * *scheduled diff* that reads `syncedAt`, and step 5's progress display reads
   * the **plugin's** own cursor, on the side that already knows where the walk
   * has reached. A field the wire carries and nothing reads is the Phase 18
   * pattern in miniature: shipped, documented, unreachable. It returns when a
   * reader for it exists.
   */
}
