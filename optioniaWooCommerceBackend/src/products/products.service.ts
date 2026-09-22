import { Injectable } from '@nestjs/common';

import {
  decodeTextCursor,
  encodeTextCursor,
} from '../common/pagination/text-keyset-cursor';
import { ListProductsDto, DEFAULT_PRODUCT_PAGE_SIZE } from './dto/list-products.dto';
import { ProductsRepository } from './products.repository';
import type { StoreProduct } from './entities/store-product.entity';

/** A product as the assignment picker sees it (M13.6). */
export interface ProductSummary {
  /** Ours. Stable across a catalogue sync. */
  id: string;
  /** WooCommerce's. This is what an assignment's `targetRef` stores. */
  externalId: string;
  name: string;
  sku: string | null;
  type: string;
  priceMinor: number | null;
  status: string;
  permalink: string | null;
  imageUrl: string | null;
}

/** One page, plus what the next request needs to continue. */
export interface ProductPage {
  readonly items: ProductSummary[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

/**
 * The merchant's catalogue, read-only (M13.6).
 *
 * **Nothing writes here.** `store_products` is a mirror of the merchant's
 * WooCommerce store, filled by [M19.1](../../developePlan.md)'s catalogue import
 * and refreshed by its sync. A dashboard that could edit it would be editing a
 * copy — the change would survive until the next sync and then vanish, which is
 * worse than not offering it.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly products: ProductsRepository) {}

  /**
   * One page of a store's catalogue.
   *
   * Reads `limit + 1` rows to answer `hasMore` without a second `COUNT(*)` over
   * the same predicate. The extra row is dropped before it reaches the caller;
   * its only job is to distinguish "this is the last page" from "there is
   * exactly one more row".
   */
  async list(query: ListProductsDto): Promise<ProductPage> {
    const limit = query.limit ?? DEFAULT_PRODUCT_PAGE_SIZE;
    const after = decodeTextCursor(query.cursor);

    const rows = await this.products.page({
      storeId: query.storeId,
      search: query.search,
      limit: limit + 1,
      after: after ? { value: after.value, id: after.id } : undefined,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(toSummary),
      /*
       * A cursor only when there is a next page. Emitting one on the last page
       * invites a client to fetch it, receive nothing, and be unable to tell
       * "empty page" from "end of list".
       */
      cursor: hasMore && last ? encodeTextCursor(last.name, last.id) : null,
      hasMore,
      limit,
    };
  }
}

/**
 * Project a product row onto the fields the picker reads.
 *
 * The same allow-list discipline as `StoresService.toSummary()`: `syncedAt`,
 * `externalUpdatedAt`, `categories` and `tags` are sync bookkeeping the picker
 * has no use for, and returning the row wholesale is how a column added later
 * becomes part of a public response nobody decided to publish.
 */
function toSummary(product: StoreProduct): ProductSummary {
  return {
    id: product.id,
    externalId: product.externalId,
    name: product.name,
    sku: product.sku ?? null,
    type: product.type,
    priceMinor: product.priceMinor ?? null,
    status: product.status,
    permalink: product.permalink ?? null,
    imageUrl: product.imageUrl ?? null,
  };
}
