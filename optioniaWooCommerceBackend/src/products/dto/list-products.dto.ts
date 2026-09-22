import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** The catalogue page the picker asks for when it asks for nothing (M13.6). */
export const DEFAULT_PRODUCT_PAGE_SIZE = 25;

/**
 * A page of a store's catalogue.
 *
 * `storeId` is required rather than optional: a tenant may have several stores,
 * and a product picker is always asking about one of them. Making it optional
 * would mean silently searching every store a tenant owns and presenting the
 * results as though they belonged together — two products with the same name on
 * two storefronts, indistinguishable in the list.
 */
export class ListProductsDto {
  @IsUUID()
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  storeId!: string;

  /**
   * Free-text match against the product name.
   *
   * Matched as a **prefix**, which is what `ix_store_products_search
   * (storeId, name)` can serve. See `ProductsService.list()` for why that is the
   * right trade today and what changes at Phase 19 scale.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ type: String })
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ type: Number })
  limit?: number;

  /** Opaque cursor from a previous page. Clients must not construct one. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @ApiPropertyOptional({ type: String })
  cursor?: string;
}
