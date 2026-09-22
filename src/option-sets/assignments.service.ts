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

/**
 * One thing a set is assigned to (M19.1').
 *
 * 🔴 **The pair, not a bare reference.** Until M19.1' the service took
 * `string[]` and supplied `PRODUCT` itself — which is why three of five target
 * types were unreachable however the enum read. A reference means nothing
 * without the type that says what it refers to.
 */
export interface AssignmentTarget {
  targetType: AssignmentTargetType;
  targetRef: string;
}


/**
 * Which mirror column holds each taxonomy's slugs.
 *
 * 🔴 **A fixed map, never interpolated from the request.** The column name goes
 * into the SQL text — it cannot be a bound parameter — so it must come from a
 * literal this file owns. Deriving it from `targetType` would put a caller's
 * string into a statement.
 */
const TAXONOMY_COLUMNS: Partial<Record<AssignmentTargetType, string>> = {
  [AssignmentTargetType.CATEGORY]: 'categories',
  [AssignmentTargetType.TAG]: 'tags',
};

/** What a bulk removal reports back. */
export interface BulkUnassignResult extends AssignmentWriteResult {
  /**
   * How many live rows this actually removed.
   *
   * Less than the number asked for when a selection had gone stale — which is
   * not an error here, so the count is the only way a caller can tell.
   */
  removed: number;
}

/** What a target would apply to, before applying it. */
export interface TargetPreview {
  /**
   * Mirrored products this target matches today, or `null` when the target
   * type has no countable meaning (`attribute`, `price_range`).
   */
  matched: number | null;
  /**
   * Whether the count is exact.
   *
   * A product target is exact — it names one thing. A taxonomy count is a
   * snapshot of the mirror, and the storefront resolves live, so it is an
   * estimate by construction.
   */
  exact: boolean;
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
  async assign(optionSetId: string, targets: AssignmentTarget[]): Promise<AssignmentWriteResult> {
    const set = await this.requireSet(optionSetId);

    /*
     * Deduplicated on the PAIR, not the reference. A category named `12` and a
     * product named `12` are different targets, and collapsing them would drop
     * one of two assignments a merchant deliberately made.
     */
    const wanted = [
      ...new Map(
        targets.map((target) => [`${target.targetType}:${target.targetRef}`, target]),
      ).values(),
    ];

    /*
     * **Finding A3: every PRODUCT target must exist in this set's own store.**
     *
     * `targetRef` holds a WooCommerce product id and has no foreign key -- the
     * product lives on the merchant's site, not in this database -- so nothing
     * in the schema stops a set being assigned to a product id belonging to
     * another store. Stored, accepted, and silently never rendering, because
     * the plugin indexes by an id that does not exist on that site.
     *
     * 🔴 **Checked for products alone, and the asymmetry is deliberate**
     * (M19.1'). A category, tag, attribute or price band is **not** a row in
     * this database: the mirror holds a product's `categories` as JSON, so the
     * equivalent check would be a `JSON_CONTAINS` scan no index can serve.
     *
     * ⚠️ **And it would reject correct configurations.** A merchant assigns a
     * set to "Summer" before stocking it — an empty category today is a valid
     * target tomorrow, and the whole point of a taxonomy assignment is that it
     * applies to products that do not exist yet. Requiring a member would make
     * the feature refuse its own purpose.
     *
     * A product id is different: it names one thing that either exists on that
     * site or does not, and a wrong one is a typo rather than a plan.
     */
    for (const target of wanted) {
      if (target.targetType !== AssignmentTargetType.PRODUCT) {
        continue;
      }

      if (!(await this.products.existsInStore(set.storeId, target.targetRef))) {
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          `No product ${target.targetRef} in this option set's store.`,
        );
      }
    }

    return this.dataSource.transaction(async (manager) => {
      for (const target of wanted) {
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

            /*
             * ⚠️ **Still `MANUAL`, for every target type.** The mode says *how*
             * a set was assigned — a merchant picked it — not *what* it was
             * assigned to. `ALL` is a property of the set, and `CONDITIONAL`
             * needs a condition tree that does not exist (ADR-069). The DTO
             * refuses `mode` as a field for the same reason: an unrecognised
             * one makes the plugin skip the assignment silently.
             */
            AssignmentMode.MANUAL,
            target.targetType,
            target.targetRef,
          ],
        );
      }

      return this.result(manager, set.storeId, optionSetId);
    });
  }

  /**
   * Unassign a set from one target.
   *
   * A **soft** delete, because the row is soft-deletable and the storefront
   * filters on the live sentinel — so the assignment stops applying the moment
   * this commits. Re-assigning later inserts a fresh row rather than reviving
   * this one, which is why `deletedAt` is part of the unique key.
   *
   * 🔴 **The type is part of the address.** `targetRef` is unique only within a
   * type: category `12` and product `12` are different rows, and the unique key
   * `(optionSetId, targetType, targetRef, deletedAt)` says so. Before M19.1'
   * this matched on `PRODUCT` alone, so removing a category assignment whose ref
   * happened to be a product id would have deleted the product's row instead —
   * and removing one whose ref matched nothing reported `NOT_FOUND` for a row
   * that was sitting right there, unremovable.
   */
  async unassign(optionSetId: string, target: AssignmentTarget): Promise<AssignmentWriteResult> {
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
          target.targetType,
          target.targetRef,
          LIVE_SENTINEL_SQL,
        ],
      );

      if (outcome.affectedRows === 0) {
        throw new DomainException(ErrorCode.NOT_FOUND, 'That target is not assigned to this set.');
      }

      return this.result(manager, set.storeId, optionSetId);
    });
  }

  /**
   * Unassign a set from many targets at once (M19.5).
   *
   * 🔴 **Missing targets are NOT an error here, and that differs from the
   * single unassign deliberately.** Removing one named target that is not
   * assigned is a mistake worth a 404 — the caller asked for a specific thing
   * that is not there. A bulk removal is a *selection*, and a selection goes
   * stale: another session unassigns a product, or a merchant re-clicks after a
   * slow response. Failing the whole request because one of fifty rows had
   * already gone would leave the other forty-nine assigned and tell the
   * merchant nothing about which. So this reports **how many it removed**.
   *
   * ⚠️ **Deduplicated on the PAIR**, like `assign()`: `targetRef` is unique
   * only within a type, so collapsing on the reference would silently drop one
   * of two removals a merchant asked for.
   *
   * The write is one statement rather than a loop: a merchant's "unassign
   * everything selected" is one decision, and applying it in fifty statements
   * inside one transaction only widens the window a concurrent publish can
   * interleave with.
   */
  async unassignMany(
    optionSetId: string,
    targets: AssignmentTarget[],
  ): Promise<BulkUnassignResult> {
    const set = await this.requireSet(optionSetId);

    const wanted = [
      ...new Map(
        targets.map((target) => [`${target.targetType}:${target.targetRef}`, target]),
      ).values(),
    ];

    return this.dataSource.transaction(async (manager) => {
      /*
       * One `UPDATE` matching any of the pairs. Built from a repeated
       * `(targetType = ? AND targetRef = ?)` group so every value stays a bound
       * parameter — a merchant's category slug is untrusted text.
       */
      const pairs = wanted.map(() => '(targetType = ? AND targetRef = ?)').join(' OR ');

      const outcome: { affectedRows: number } = await manager.query(
        `UPDATE option_set_assignments
            SET deletedAt = NOW(3), updatedAt = NOW(3)
          WHERE optionSetId = ? AND mode = ? AND deletedAt = ?
            AND (${pairs})`,
        [
          optionSetId,
          AssignmentMode.MANUAL,
          LIVE_SENTINEL_SQL,
          ...wanted.flatMap((target) => [target.targetType, target.targetRef]),
        ],
      );

      const { assignments, configVersion } = await this.result(
        manager,
        set.storeId,
        optionSetId,
      );

      return { assignments, configVersion, removed: outcome.affectedRows };
    });
  }

  /**
   * How many mirrored products a target would apply to, before applying it
   * (M19.5).
   *
   * 🔴 **A count, not a promise.** For a **category** or **tag** this counts the
   * products the *mirror* holds in that term, and the mirror is a snapshot: the
   * storefront resolves taxonomy live through `has_term()` (ADR-068), so a
   * product categorised after this count still matches. The number answers
   * *"roughly how many does this touch today?"* — which is the question a
   * merchant asks before clicking — and it must not be described as the set of
   * products that will render.
   *
   * ⚠️ **`JSON_CONTAINS` cannot use an index, and that is acceptable HERE.**
   * `categories` is a JSON column with no generated column behind it, so this
   * filters within one store's rows. Measured on the real plan: MySQL takes the
   * `storeId` index lookup first and applies the JSON test to that subset only,
   * so the work is bounded by one merchant's catalogue rather than the table.
   * This runs in the **dashboard**, on an explicit click — [AC3](../../../developePlan.md)
   * governs the storefront product page and is not implicated.
   *
   * 📌 **The slug is what is stored.** `CataloguePayload::terms()` sends
   * `$term->slug`, so the mirror's `categories` holds slugs and an assignment's
   * `targetRef` holds the same slug. Verified against a plugin-pushed row.
   */
  async previewTarget(optionSetId: string, target: AssignmentTarget): Promise<TargetPreview> {
    const set = await this.requireSet(optionSetId);

    if (target.targetType === AssignmentTargetType.PRODUCT) {
      const exists = await this.products.existsInStore(set.storeId, target.targetRef);

      return { matched: exists ? 1 : 0, exact: true };
    }

    const column = TAXONOMY_COLUMNS[target.targetType];

    if (column === undefined) {
      /*
       * `attribute` and `price_range` have no defined reference format
       * (ADR-076), so there is nothing to count. Reported as unknown rather
       * than as zero: zero is a measurement, and this is the absence of one.
       */
      return { matched: null, exact: false };
    }

    const rows: Array<{ matched: number }> = await this.dataSource.query(
      `SELECT COUNT(*) AS matched FROM store_products
        WHERE storeId = ? AND JSON_CONTAINS(${column}, JSON_QUOTE(?))`,
      [set.storeId, target.targetRef],
    );

    return { matched: Number(rows[0]?.matched ?? 0), exact: false };
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
