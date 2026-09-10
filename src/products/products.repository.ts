import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { requireTenantId } from '../common/context/request-context';
import { StoreProduct } from './entities/store-product.entity';

/** How the catalogue is ordered, and therefore how it pages. */
export interface ProductPageQuery {
  readonly storeId: string;
  readonly search?: string;
  readonly limit: number;
  readonly after?: { readonly value: string; readonly id: string };
}

/**
 * A store's catalogue, scoped through its store.
 *
 * ## Why not `ParentScopedRepository`
 *
 * That base class is the obvious fit — `store_products` reaches its tenant
 * through `stores`, exactly as `option_groups` reaches it through
 * `option_sets` — and it is the **wrong** fit, verified before a query was
 * written rather than after one failed.
 *
 * Its join emits `parent.deletedAt = :liveSentinel` on every link and
 * `child.deletedAt = :liveSentinel` on the child, because every entity it was
 * built for extends `SoftDeletableEntity`. `Store` and `StoreProduct` extend the
 * plain `BaseEntity`, and **neither table has a `deletedAt` column** — confirmed
 * against `InitialSchema`. Using it would generate SQL referencing a column that
 * does not exist.
 *
 * A catalogue is not soft-deletable on purpose: it is a **mirror** of the
 * merchant's WooCommerce store, replaced by [M19](../../developePlan.md)'s sync
 * rather than edited here. A product deleted upstream should disappear, not
 * linger as a tombstone a picker could still assign to.
 *
 * So the scope is written explicitly, in one place, and every read goes through
 * it.
 */
@Injectable()
export class ProductsRepository {
  constructor(
    @InjectRepository(StoreProduct)
    private readonly repository: Repository<StoreProduct>,
  ) {}

  /**
   * One page of a store's catalogue, ordered by name.
   *
   * ## Keyset, not offset
   *
   * `OFFSET` re-counts every skipped row on each page and shifts under
   * concurrent writes — and this table is rewritten wholesale by catalogue sync,
   * so pages would duplicate and skip rows precisely while a merchant browses
   * during a sync. The `(name, id)` key is stable against that.
   *
   * ## Why `(name, id)` rather than `(createdAt, id)`
   *
   * `ix_store_products_search (storeId, name)` is the only useful index on this
   * table. Paging on `createdAt` would filesort the whole catalogue for every
   * page, and would present products in import order — which is not an order a
   * merchant can navigate. `id` breaks ties, because two products may share a
   * name and a keyset needs a total order.
   *
   * ## The search is a prefix match
   *
   * `LIKE 'term%'` uses the index; `LIKE '%term%'` cannot and scans. At the 30
   * products the seed creates that difference is invisible, and until
   * [M19.1](../../developePlan.md) imports a real catalogue there is nothing
   * larger to scan. Recorded as finding **A4** of Phase 13 Stage 0: the day this
   * needs substring search is the day it needs a `FULLTEXT` index, and that is a
   * migration, not a `LIKE` pattern.
   */
  async page(query: ProductPageQuery): Promise<StoreProduct[]> {
    const builder = this.repository
      .createQueryBuilder('p')
      /*
       * The tenant scope, as a join rather than a column comparison.
       *
       * `store_products` carries no `tenantId`; it reaches one only through its
       * store. An `INNER JOIN` means a product whose store belongs to another
       * tenant produces no row at all -- the same answer as a product that does
       * not exist.
       */
      .innerJoin('stores', 's', 's.id = p.storeId AND s.tenantId = :tenantId', {
        tenantId: requireTenantId(),
      })
      .where('p.storeId = :storeId', { storeId: query.storeId });

    if (query.search) {
      builder.andWhere('p.name LIKE :search', { search: `${escapeLike(query.search)}%` });
    }

    if (query.after) {
      /*
       * The keyset predicate, as a row comparison.
       *
       * `(name, id) > (:name, :id)` in one tuple rather than
       * `name > :name OR (name = :name AND id > :id)`. Both are correct; the
       * tuple form is the one MySQL can satisfy from the index without
       * re-evaluating a disjunction per row.
       */
      builder.andWhere('(p.name, p.id) > (:afterName, :afterId)', {
        afterName: query.after.value,
        afterId: query.after.id,
      });
    }

    /*
     * `ORDER BY name, id` — and the `id` half is belt-and-braces, proven so.
     *
     * Removing `addOrderBy('p.id')` alone changes nothing observable: MySQL
     * returns these rows in `ix_store_products_search (storeId, name)` order,
     * and the keyset predicate above still tie-breaks on `id`, so paging stays
     * correct. Measured — that mutant survives all 15 tests.
     *
     * What is **not** equivalent is dropping `id` from the *predicate*: a
     * name-only cursor asks for `name > 'Custom Hoodie'` and skips the second
     * copy when a page boundary falls between two identical names. That mutant
     * is killed by `does not skip a duplicate name across a page boundary`.
     *
     * The clause stays because index order is a MySQL implementation detail, not
     * a contract, and a total order stated explicitly is one the next reader can
     * rely on.
     */
    return builder
      .orderBy('p.name', 'ASC')
      .addOrderBy('p.id', 'ASC')
      .take(query.limit)
      .getMany();
  }

  /**
   * Whether a product exists in this store, for this tenant.
   *
   * The ownership check an assignment needs before it writes a `targetRef`
   * (finding **A3**). Keyed on `externalId` because that is what an assignment
   * stores -- a **WooCommerce** product id, not one of ours.
   */
  async existsInStore(storeId: string, externalId: string): Promise<boolean> {
    const count = await this.repository
      .createQueryBuilder('p')
      .innerJoin('stores', 's', 's.id = p.storeId AND s.tenantId = :tenantId', {
        tenantId: requireTenantId(),
      })
      .where('p.storeId = :storeId AND p.externalId = :externalId', { storeId, externalId })
      .getCount();

    return count > 0;
  }
}

/**
 * Neutralise `LIKE` wildcards in merchant input.
 *
 * Without this, a search for `100%` matches every product: `%` is a wildcard,
 * not a character. `\` is escaped first, or escaping the others would double it.
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
