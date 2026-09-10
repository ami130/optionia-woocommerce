import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { OptionalNotNull, Trimmed } from '../../common/validation/trimmed.decorator';
import {
  IsEnum,
  IsInt,
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
