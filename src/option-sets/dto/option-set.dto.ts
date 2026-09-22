import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OptionalNotNull, Trimmed } from '../../common/validation/trimmed.decorator';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { OptionSetStatus } from '../../common/database/enums';

/**
 * Request shapes for option-set endpoints.
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so an unexpected field is rejected rather than dropped — which is what stops a
 * caller probing for fields the API might accept.
 *
 * Length limits are on every string. Without them a multi-megabyte name reaches
 * the database, and the cheapest denial of service available is a large body.
 */

export class CreateOptionSetDto {
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A name is required.' })
  @MaxLength(255)
  @ApiProperty({ type: String })
  name: string;

  /**
   * The store this set belongs to.
   *
   * Required rather than inferred: a tenant may connect several stores, and
   * guessing which one a set belongs to is the kind of convenience that produces
   * options on the wrong storefront.
   */
  @IsUUID()
  @ApiProperty({ type: String })
  storeId: string;
}

export class UpdateOptionSetDto {
  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1, { message: 'A name cannot be empty.' })
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  name?: string;

  /**
   * Status transitions are deliberately **not** here.
   *
   * Publishing is [7i] with its own endpoint, because it is a transaction that
   * validates the whole set, writes a snapshot and bumps a store's config
   * version — not a field a `PATCH` can set. Allowing `status` here would let a
   * merchant mark a set published without any of that happening.
   */

  /**
   * The version the client loaded, for optimistic locking ([7j]).
   *
   * Optional until concurrency control lands, so this step does not ship a
   * required field nothing enforces.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ type: Number })
  rowVersion?: number;
}

/** Filters and paging for the list endpoint. */
export class ListOptionSetsDto {
  @IsOptional()
  @IsEnum(OptionSetStatus, { message: 'Unknown status.' })
  @ApiPropertyOptional({ enum: OptionSetStatus })
  status?: OptionSetStatus;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String })
  storeId?: string;

  /** Name search. Matched as a prefix, so an index can serve it later. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  q?: string;

  /**
   * Page size. Capped rather than rejected above the maximum: a client asking
   * for 1000 wants "as many as possible", and refusing the request helps nobody.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ type: Number })
  limit?: number;

  /** Opaque cursor from a previous page. Clients must not construct one. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  cursor?: string;
}

/**
 * A set rebuilt from an exported document (M20.8).
 *
 * 🔴 **The document is `Record<string, unknown>` on purpose.** Its *shape* is
 * validated in the service, against the same registry and per-type schemas that
 * validate an authored option — because a file arrives hand-edited, from a
 * future release, or simply wrong. A DTO that described the tree would be a
 * second definition of what an option set is, and the two would disagree the
 * first time either changed.
 */
export class ImportOptionSetDto {
  /**
   * Which store the imported set belongs to.
   *
   * ⚠️ **Checked against the acting tenant in the service.** A store id is
   * caller-supplied, and the scoped repository stamps the tenant on the new row
   * — so an unchecked target would produce a set that belongs to this tenant
   * while pointing at somebody else's storefront.
   */
  @IsUUID()
  @ApiProperty({ type: String })
  storeId!: string;

  @IsObject()
  @ApiProperty({ type: Object })
  document!: Record<string, unknown>;
}

export class DuplicateOptionSetDto {
  /**
   * Name for the copy. Defaults to the original with a `(copy)` suffix.
   *
   * Optional because the common case is "give me another one like this", and
   * requiring a name up front interrupts that.
   */
  @OptionalNotNull()
  @IsString()
  @Trimmed()
  @MinLength(1)
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  name?: string;

  /**
   * Copy into a different store of the same tenant (M20.8).
   *
   * 🔴 **The multi-store differentiator [D5] promises.** `duplicate` copied
   * into the source's own store, so a merchant running three storefronts
   * rebuilt the same option set by hand for each.
   *
   * ⚠️ **Checked against the acting tenant in the service**, never trusted: a
   * target store is a caller-supplied id, and without that check a merchant
   * could attach a copy to another tenant's storefront. The refusal is a
   * **404**, so a store in another tenant is indistinguishable from one that
   * does not exist.
   *
   * 📌 **Optional, defaulting to the source's store**, because the common case
   * is still "another one like this, here".
   */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String })
  storeId?: string;
}

/**
 * A delete carries its version as a **query parameter**.
 *
 * `DELETE` bodies are legal but poorly supported — proxies drop them and some
 * HTTP clients refuse to send one — so the optimistic lock rides in the query
 * string where every client can put it.
 */
export class DeleteOptionSetDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  rowVersion?: number;
}
