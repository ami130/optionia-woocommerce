import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigVersionService } from '../common/config-version.service';
import { AssignmentMode, AssignmentTargetType } from '../common/database/enums';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ProductsRepository } from '../products/products.repository';
import { OptionSetsRepository } from './option-sets.repository';

/** An assignment as the picker sees it. */
export interface AssignmentView {
  id: string;
  mode: string;
  targetType: string | null;
  /** The **WooCommerce** product id this targets. */
  targetRef: string | null;
  priority: number;

  /**
   * The product's name, joined from `store_products`.
   *
   * 🔴 **Without this the picker renders `1042` where a merchant expects
   * "Custom Hoodie".** `targetRef` is a WooCommerce id, and it cannot be resolved
   * client-side: `GET /products` takes only `storeId`, `search`, `limit` and
   * `cursor` — no id filter — so naming N assigned products would mean paging the
   * whole catalogue or making N searches.
   *
   * `null` when the product is not in `store_products`: either the catalogue has
   * not synced yet ([M19.1](../../developePlan.md)), or it was deleted upstream
   * after being assigned.
   */
  productName: string | null;

  /**
   * The product's status upstream, or `null` if it is no longer there.
   *
   * ⚠️ **As important as the name.** A product deleted or unpublished since it was
   * assigned still has a row here, and a merchant reading "assigned to 4
   * products" deserves to know one of them no longer exists — otherwise the
   * option quietly stops appearing and the assignment list still says it should.
   */
  productStatus: string | null;
}

/** What a write reports back. */
export interface AssignmentWriteResult {
  /** The set's live assignments after the change. */
  assignments: AssignmentView[];
  /** The store revision the storefront must reach to see this. */
  configVersion: number;
}

/**
 * Which products an option set applies to (M13.6).
 *
 * ## Every write advances `config_version`
 *
 * Assignments are a **live** read in the storefront document — `config-document`
 * queries them directly rather than from a published snapshot, so an assignment
 * added here changes what a storefront serves immediately. A write that did not
 * advance the revision would leave every connected plugin serving a document it
 * believes is current, and the option would appear only after the next unrelated
 * publish. `bin/check-config-invalidation.sh` enforces this.
 *
 * ## `MANUAL` and `product`, written explicitly
 *
 * Never defaulted, never taken from the request. The plugin skips an assignment
 * whose mode it does not recognise and counts it as deferred, so a wrong value
 * produces an option that never renders with a skip counter as the only trace.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly sets: OptionSetsRepository,
    private readonly products: ProductsRepository,
    private readonly configVersion: ConfigVersionService,
    private readonly dataSource: DataSource,
  ) {}

  /** A set's live assignments. */
  async list(optionSetId: string): Promise<AssignmentView[]> {
    const set = await this.requireSet(optionSetId);

    return this.readAssignments(this.dataSource, set.storeId, optionSetId);
  }

  /**
   * Assign a set to one or more products.
   *
   * **Idempotent.** A product already assigned is left alone rather than
   * duplicated or rejected: the picker is a UI where a double submit is
   * ordinary, and `uq_assignments_set_target` would turn the second one into a
   * constraint violation the merchant did not cause. The unique index remains
   * the guarantee — this is the path that makes it invisible.
   */
  async assign(optionSetId: string, externalProductIds: string[]): Promise<AssignmentWriteResult> {
    const set = await this.requireSet(optionSetId);
    const wanted = [...new Set(externalProductIds)];

    /*
     * **Finding A3: every target must exist in this set's own store.**
     *
     * `targetRef` holds a WooCommerce product id and has no foreign key -- the
     * product lives on the merchant's site, not in this database -- so nothing
     * in the schema stops a set being assigned to a product id belonging to
     * another store. Stored, accepted, and silently never rendering, because
     * the plugin indexes by an id that does not exist on that site.
     */
    for (const externalId of wanted) {
      if (!(await this.products.existsInStore(set.storeId, externalId))) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          `No product ${externalId} in this option set's store.`,
        );
      }
    }

    return this.dataSource.transaction(async (manager) => {
      for (const externalId of wanted) {
        /*
         * 🔴 **Upsert, not `SELECT`-then-`INSERT`.**
         *
         * The first version read the live targets, filtered out the ones already
         * present, and inserted the rest. That looks idempotent and is not: two
         * requests racing both find a product missing and both insert, and
         * `uq_assignments_set_target` turns the loser into a **409 for a request
         * that should have succeeded**. Measured before this was written --
         * three concurrent assigns of the same product answered
         * `[200, 409, 409]` -- and a picker's double-click is exactly that
         * scenario.
         *
         * This is the same defect Phase 12 fixed in `OrdersService.report()`,
         * written a second time here. The database resolves the race; the
         * application cannot.
         *
         * `updatedAt` is the only column touched on a conflict. There is nothing
         * to change -- the row already says what this request asks for -- but
         * MySQL needs an assignment, and touching `updatedAt` records that the
         * merchant asked again.
         *
         * **The tombstone is not matched.** `deletedAt` is part of the unique
         * key and this inserts the live sentinel, so an unassigned row (whose
         * `deletedAt` is the moment it was removed) has a different key and does
         * not collide. Re-assigning inserts a fresh live row, which is the
         * behaviour `a product can be re-assigned after being unassigned`
         * asserts.
         */
        await manager.query(
          `INSERT INTO option_set_assignments
             (id, createdAt, updatedAt, deletedAt, optionSetId, mode, targetType, targetRef, priority)
           VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE updatedAt = NOW(3)`,
          [
            LIVE_SENTINEL_SQL,
            optionSetId,
            AssignmentMode.MANUAL,
            AssignmentTargetType.PRODUCT,
            externalId,
          ],
        );
      }

      return this.result(manager, set.storeId, optionSetId);
    });
  }

  /**
   * Unassign a set from one product.
   *
   * A **soft** delete, because the row is soft-deletable and the storefront
   * filters on the live sentinel — so the assignment stops applying the moment
   * this commits. Re-assigning later inserts a fresh row rather than reviving
   * this one, which is why `deletedAt` is part of the unique key.
   */
  async unassign(optionSetId: string, externalProductId: string): Promise<AssignmentWriteResult> {
    const set = await this.requireSet(optionSetId);

    return this.dataSource.transaction(async (manager) => {
      const outcome: { affectedRows: number } = await manager.query(
        `UPDATE option_set_assignments
            SET deletedAt = NOW(3), updatedAt = NOW(3)
          WHERE optionSetId = ? AND mode = ? AND targetType = ? AND targetRef = ?
            AND deletedAt = ?`,
        [
          optionSetId,
          AssignmentMode.MANUAL,
          AssignmentTargetType.PRODUCT,
          externalProductId,
          LIVE_SENTINEL_SQL,
        ],
      );

      if (outcome.affectedRows === 0) {
        throw new DomainException(ErrorCode.NOT_FOUND, 'That product is not assigned to this set.');
      }

      return this.result(manager, set.storeId, optionSetId);
    });
  }

  /**
   * The set, or a 404.
   *
   * `OptionSetsRepository` is tenant-scoped, so another tenant's id resolves to
   * nothing — the same answer as an id that does not exist (ADR-010).
   */
  private async requireSet(optionSetId: string): Promise<{ id: string; storeId: string }> {
    const set = await this.sets.findById(optionSetId);

    if (!set) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Option set not found.');
    }

    return { id: set.id, storeId: set.storeId };
  }

  /** Advance the revision and report the set's live assignments. */
  private async result(
    manager: EntityManager,
    storeId: string,
    optionSetId: string,
  ): Promise<AssignmentWriteResult> {
    const configVersion = await this.configVersion.bump(manager, storeId);

    /*
     * The same joined read the list uses, so a write answers with names too.
     * A picker that showed "Custom Hoodie" on reload and `1042` immediately
     * after assigning would look broken at the one moment a merchant is
     * watching.
     */
    const assignments = await this.readAssignments(manager, storeId, optionSetId);

    return { assignments, configVersion };
  }

  /**
   * A set's live assignments, each named.
   *
   * `LEFT JOIN`, not an inner one: an assignment whose product has gone from
   * `store_products` must still be **listed**, so a merchant can see it and
   * remove it. An inner join would hide exactly the rows that need attention.
   *
   * Scoped by `storeId` on the join as well as by set: `targetRef` is a
   * WooCommerce id, unique only within a store, so joining on it alone would
   * name a product from a different store when two shops share an id — which
   * they routinely do, since WooCommerce numbers from 1 on every install.
   */
  private async readAssignments(
    runner: DataSource | EntityManager,
    storeId: string,
    optionSetId: string,
  ): Promise<AssignmentView[]> {
    return runner.query(
      `SELECT a.id, a.mode, a.targetType, a.targetRef, a.priority,
              p.name AS productName, p.status AS productStatus
         FROM option_set_assignments a
         LEFT JOIN store_products p
           ON p.storeId = ? AND p.externalId = a.targetRef
        WHERE a.optionSetId = ? AND a.deletedAt = ?
        ORDER BY a.priority ASC, a.id ASC`,
      [storeId, optionSetId, LIVE_SENTINEL_SQL],
    ) as Promise<AssignmentView[]>;
  }
}
