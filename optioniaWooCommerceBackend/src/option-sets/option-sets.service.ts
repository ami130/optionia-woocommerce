import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { getTenantId } from '../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import {
  GroupDisplayType,
  OptionSetStatus,
  PresentationalKind,
  PriceType,
} from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
import { PresentationalItem } from './entities/presentational-item.entity';
import { OptionTypeValidator } from './types/option-type.validator';
import { AUTHORING_LIMITS } from './authoring-limits';
import { findType } from './types/type-registry';
import { copyOptionsInto, copyRulesInto } from './option-groups.service';
import { AlreadyDeletedError, CascadeService } from './cascade.service';
import { assertVersionMatches } from './optimistic-lock';
import { HardDeleteService, type PurgeResult } from './hard-delete.service';
import { OptionSetsRepository, type ListFilters, type ListPage } from './option-sets.repository';
import type { AuthoringOptionSet, PublishedOptionSet } from './serialization/projections';
import { OptionSetTreeLoader } from './serialization/option-set-tree.loader';
import { OptionSetSerializer } from './serialization/option-set.serializer';

/** The default page size when a caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Option set lifecycle (M7.1).
 *
 * Every mutation returns **what changed**, not just success — M7.6 requires a
 * diff with before-and-after, and a diff reconstructed after the write is a
 * guess. Stated in the Phase 7 plan for exactly this reason.
 */
@Injectable()
export class OptionSetsService {
  constructor(
    private readonly repository: OptionSetsRepository,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly cascade: CascadeService,
    private readonly hardDelete: HardDeleteService,
    private readonly trees: OptionSetTreeLoader,
    private readonly serializer: OptionSetSerializer,
    private readonly validator: OptionTypeValidator,
  ) {}

  /**
   * A set with everything under it, in the dashboard's shape (M7.2b).
   *
   * The editor needs the whole tree in one request — fetching groups, then
   * options per group, then values per option is a render that gets slower the
   * more work a merchant has done.
   */
  async findOneDetailed(id: string): Promise<AuthoringOptionSet> {
    return this.serializer.toAuthoring(await this.trees.load(id));
  }

  /**
   * The published projection of a set, for preview and for publish ([7i]).
   *
   * Produced by the **same serializer** that builds the config document, so a
   * preview cannot disagree with what a storefront will render — which is the
   * whole reason M7.2b asks for one serializer rather than one per consumer.
   */
  async findOnePublished(id: string): Promise<PublishedOptionSet> {
    return this.serializer.toPublished(await this.trees.load(id));
  }

  async list(filters: Partial<ListFilters>): Promise<ListPage> {
    return this.repository.list({
      ...filters,
      limit: filters.limit ?? DEFAULT_PAGE_SIZE,
    });
  }

  /**
   * One option set.
   *
   * Not found and belongs-to-another-tenant are the same answer, because
   * distinguishing them lets a caller walk ids and learn which exist (ADR-010).
   */
  async findOne(id: string): Promise<OptionSet> {
    const set = await this.repository.findById(id);

    if (!set) {
      throw DomainException.notFound('Option set');
    }

    return set;
  }

  async create(name: string, storeId: string): Promise<OptionSet> {
    await this.assertStoreBelongsToTenant(storeId);

    const created = await this.repository.create({
      name: name.trim(),
      storeId,
      status: OptionSetStatus.DRAFT,
      // Zero, not one: `version` counts **publishes**, and a draft that has
      // never been published has none. Creating at 1 made the first publish
      // produce version 2 and left a never-published set claiming a version no
      // snapshot exists for.
      version: 0,
      rowVersion: 1,
      publishedConfigVersion: 0,
    } as never);

    await this.audit.record({
      action: AuditAction.OPTION_SET_CREATED,
      resourceType: 'option_set',
      resourceId: created.id,
      changes: diff(null, { name: created.name, storeId, status: created.status }),
    });

    return created;
  }

  /**
   * Rename a set.
   *
   * `status` is deliberately not updatable here: publishing is a transaction
   * that validates the set, writes a snapshot and bumps a store's config version
   * ([7i]), and a `PATCH` that could set it would let a merchant mark a set
   * published with none of that having happened.
   */
  async update(
    id: string,
    changes: { name?: string },
    expectedRowVersion?: number,
  ): Promise<OptionSet> {
    const before = await this.findOne(id);

    /**
     * The conflict is answered **before** the no-op guards below (M7.4b).
     *
     * A client that loaded version 4, had its set changed by a colleague, and
     * then saved an unchanged name must still be told. Returning early because
     * nothing differs would hide a real conflict behind a coincidence — and the
     * next save, on a value that *does* differ, would be the silent overwrite
     * this exists to prevent.
     */
    assertVersionMatches(before.rowVersion, expectedRowVersion);

    if (changes.name === undefined) {
      return before;
    }

    const name = changes.name.trim();

    // No-op guard: renaming a set to the name it already has should not burn a
    // `rowVersion` — doing so would invalidate every other editor's loaded copy
    // for a write that changed nothing.
    if (name === before.name) {
      return before;
    }

    const affected = await this.repository.applyChange(
      id,
      { name } as Partial<OptionSet>,
      expectedRowVersion,
    );

    /**
     * Lost the race.
     *
     * The row was live when it was read a moment ago, so `affected = 0` here
     * means another editor committed in between and the version predicate no
     * longer matches. Re-read to report the version they should reload.
     */
    if (affected === 0) {
      throw DomainException.versionMismatch(
        'This option set was changed by someone else.',
        (await this.findOne(id)).rowVersion,
      );
    }

    await this.audit.record({
      action: AuditAction.OPTION_SET_UPDATED,
      resourceType: 'option_set',
      resourceId: id,
      changes: diff({ name: before.name }, { name }),
    });

    return this.findOne(id);
  }

  /**
   * Soft delete.
   *
   * The set is hidden and excluded from published config; historic orders are
   * unaffected, because `order_selections` stores keys denormalised (ADR-016).
   * Hard delete is a separate operation with its own precondition ([7g]).
   */
  async remove(id: string, expectedRowVersion?: number): Promise<void> {
    const before = await this.findOne(id);

    /**
     * A stale delete matters **more** than a stale rename, not less.
     *
     * Deleting a set someone else has been editing discards their work along
     * with it, and the cascade takes every group, option and value with it. A
     * merchant who loaded the set before those edits existed did not decide to
     * delete them.
     */
    assertVersionMatches(before.rowVersion, expectedRowVersion);

    // One instant for the whole cascade, so every row this action removed can be
    // identified together afterwards.
    const deletedAt = new Date();

    let cascaded;

    try {
      // The cascade marks the set itself too, in the same transaction — so
      // there is no second write that could leave the children deleted and the
      // parent live.
      cascaded = await this.cascade.onOptionSetDeleted(id, deletedAt, {
        storeId: before.storeId,
        // Only a published set is in the config document, so only its removal
        // is something a storefront can see. Deleting a draft changes nothing a
        // plugin would fetch, and bumping for it would invalidate every
        // storefront cache for an edit no customer can observe.
        wasPublished: before.status === OptionSetStatus.PUBLISHED,
      });
    } catch (error) {
      if (error instanceof AlreadyDeletedError) {
        // Another request deleted it first. The caller's intent is satisfied,
        // so this is still a success — it simply does not record a second
        // audit entry for one deletion.
        return;
      }

      throw error;
    }

    await this.audit.record({
      action: AuditAction.OPTION_SET_DELETED,
      resourceType: 'option_set',
      resourceId: id,
      changes: {
        ...diff(
          { name: before.name, status: before.status, deleted: false },
          { name: before.name, status: before.status, deleted: true },
        ),
        // What went with it. A merchant asking "where did my options go?" is
        // answered from the trail rather than by inference.
        cascaded,
      },
    });
  }

  /**
   * Permanently erase a set (M7.2, "Delete (hard)").
   *
   * Separate from `remove` because the precondition is different in kind: a soft
   * delete is always allowed, and this is refused whenever an order ever named
   * one of the set's option keys. See `HardDeleteService` for why that check
   * cannot be a foreign key.
   */
  async purge(id: string): Promise<PurgeResult> {
    // Deliberately includes soft-deleted sets: delete-then-erase is the normal
    // path, and `findOne` would make an already-deleted set unreachable.
    const before = await this.repository.findByIdIncludingDeleted(id);

    if (!before) {
      throw DomainException.notFound('Option set');
    }
    const purged = await this.hardDelete.purge(before);

    await this.audit.record({
      action: AuditAction.OPTION_SET_PURGED,
      resourceType: 'option_set',
      // The row is gone, so the id is recorded as a value rather than a link.
      resourceId: id,
      changes: { ...diff({ name: before.name, storeId: before.storeId }, null), purged },
    });

    return purged;
  }

  /**
   * Deep copy a set, including its groups, options and values.
   *
   * **One transaction.** A partially copied set is worse than no copy: the
   * merchant sees something that looks finished and is missing values they will
   * not notice until a customer cannot pick one.
   *
   * The copy is always a **draft**, whatever the original was. Duplicating a
   * published set and having the copy go live immediately would publish work
   * nobody reviewed.
   */
  /**
   * Rebuild a set from an exported document (M20.8).
   *
   * 🔴 **One transaction, because a part-written set has no undo.** Creating a
   * tree is a group, then options, then values, then items — and doing it as a
   * sequence of requests from the dashboard would leave a set nobody authored
   * when a document failed halfway. A create is a shape change that clears the
   * undo log, so there would be no way back.
   *
   * 📌 **The same shape `duplicate` already proved.** An import is that
   * operation with a *document* as the source rather than a row; the atomicity
   * requirement is identical and so is the traversal.
   *
   * ⚠️ **Every option is validated by the registry on the way in**, exactly as
   * an authored one is. A document arrives hand-edited or from a future
   * release, and trusting it because this product wrote one like it is how a
   * malformed file becomes a malformed set.
   */
  async importDocument(
    storeId: string,
    document: Record<string, unknown>,
  ): Promise<OptionSet> {
    await this.assertStoreBelongsToTenant(storeId);

    const name = typeof document.name === 'string' ? document.name.trim() : '';

    if (name === '') {
      throw DomainException.validation([{ field: 'document.name', code: 'REQUIRED' }]);
    }

    const groups = Array.isArray(document.groups) ? document.groups : [];

    if (groups.length === 0) {
      throw DomainException.validation([{ field: 'document.groups', code: 'REQUIRED' }]);
    }

    if (groups.length > AUTHORING_LIMITS.groupsPerSet) {
      throw DomainException.validation([{ field: 'document.groups', code: 'TOO_MANY' }]);
    }

    const created = await this.dataSource.transaction(async (manager) => {
      const tenantId = getTenantId();

      if (tenantId === null) {
        /* Unreachable behind the guard; stated rather than coerced. */
        throw DomainException.notFound('Store');
      }

      const set = await manager.save(
        manager.create(OptionSet, {
          tenantId,
          storeId,
          name,
          /*
           * 🔴 **Always a draft, whatever the document claims.** A file could
           * name a status and a version; honouring them would publish work
           * nobody reviewed onto a storefront customers are buying from.
           */
          status: OptionSetStatus.DRAFT,
          version: 0,
          rowVersion: 1,
          publishedConfigVersion: 0,
        }),
      );

      for (const [g, rawGroup] of groups.entries()) {
        const group = rawGroup as Record<string, unknown>;

        const groupRow = await manager.save(
          manager.create(OptionGroup, {
            optionSetId: set.id,
            label: String(group.label ?? '').trim(),
            description: typeof group.description === 'string' ? group.description : null,
            /*
             * ⚠️ **Checked against the real set, not cast.** A document may
             * name a layout that does not exist; falling back to `inline` is
             * what the plugin's renderer already does for an unknown one, so
             * the two agree rather than the import inventing a value.
             */
            displayType: Object.values(GroupDisplayType).includes(
              group.displayType as GroupDisplayType,
            )
              ? (group.displayType as GroupDisplayType)
              : GroupDisplayType.INLINE,
            sortOrder: typeof group.sortOrder === 'number' ? group.sortOrder : g * 10,
            isCollapsible: group.isCollapsible === true,
            /* Disabled work stays disabled, as everywhere else. */
            isEnabled: group.isEnabled !== false,
          }),
        );

        const options = Array.isArray(group.options) ? group.options : [];

        /*
         * 🔴 **The limits the API owns, enforced by the API.** The dashboard
         * checks them before sending, which makes the UI path safe — but a
         * client check is never the boundary, and this endpoint is guarded by a
         * capability rather than by a client.
         */
        if (options.length > AUTHORING_LIMITS.optionsPerGroup) {
          throw DomainException.validation([
            { field: `document.groups.${g}.options`, code: 'TOO_MANY' },
          ]);
        }

        for (const [o, rawOption] of options.entries()) {
          const option = rawOption as Record<string, unknown>;
          const presentation = String(option.presentation ?? '');

          /*
           * 🔴 **The registry validates it, not this loop.** A presentation it
           * does not know, a pricing shape it refuses, a validation rule that
           * contradicts itself — all of it is the same check an authored option
           * passes, and it throws inside the transaction so nothing is written.
           */
          /*
           * 🔴 **Looked up first, so an unknown presentation fails before the
           * registry-driven checks run on `undefined`.** `findType` returning
           * null is a document naming a type this release does not have.
           */
          const definition = findType(presentation);

          if (definition === null) {
            throw DomainException.validation([
              { field: `document.groups.${g}.options.${o}.presentation`, code: 'UNKNOWN_TYPE' },
            ]);
          }

          this.validator.assertValidOption(presentation, {
            validation: option.validation ?? null,
            pricing: option.pricing ?? null,
            display: option.display ?? null,
          });

          const optionRow = await manager.save(
            manager.create(Option, {
              optionGroupId: groupRow.id,
              key: String(option.key ?? '').trim(),
              valueKind: definition.valueKind,
              cardinality: definition.cardinality[0],
              /*
               * 📌 **Taken from the DEFINITION the validator returned**, not
               * from the document: it has already proved the presentation
               * exists, and reading it back narrows the type without a cast
               * that could outlive the check.
               */
              presentation: definition.presentation,
              label: String(option.label ?? '').trim(),
              description: typeof option.description === 'string' ? option.description : null,
              placeholder: typeof option.placeholder === 'string' ? option.placeholder : null,
              helpText: typeof option.helpText === 'string' ? option.helpText : null,
              isRequired: option.isRequired === true,
              isEnabled: option.isEnabled !== false,
              sortOrder: typeof option.sortOrder === 'number' ? option.sortOrder : o * 10,
              defaultValue: typeof option.defaultValue === 'string' ? option.defaultValue : null,
              validation: (option.validation ?? null) as never,
              pricing: (option.pricing ?? null) as never,
              display: (option.display ?? null) as never,
            }),
          );

          const values = Array.isArray(option.values) ? option.values : [];

          /*
           * 🔴 **A valueless type must refuse values, not collect them
           * silently.** `option-values.service.ts` states the reason: the
           * publish check deliberately looks past a valueless option's values,
           * so rows created here would *"exist, validate, publish, and mean
           * nothing"* — and the storefront would render an input that ignores
           * them.
           *
           * ⚠️ **The import wrote rows through `manager.save` directly**, so it
           * never passed the guard the create path applies. Mirroring
           * `duplicate`'s *transaction* shape was not enough: a duplicate copies
           * rows that already passed these checks, and an import's rows have
           * passed nothing.
           */
          if (values.length > 0 && !definition.takesValues) {
            throw DomainException.validation([
              { field: `document.groups.${g}.options.${o}.values`, code: 'TYPE_TAKES_NO_VALUES' },
            ]);
          }

          if (values.length > AUTHORING_LIMITS.valuesPerOption) {
            throw DomainException.validation([
              { field: `document.groups.${g}.options.${o}.values`, code: 'TOO_MANY' },
            ]);
          }

          /*
           * ⚠️ **A duplicate key reached the database and became a 500.** The
           * unique index caught it, so nothing was corrupted — but a merchant
           * met a server error where the create path names the field.
           */
          const seenKeys = new Set<string>();

          for (const [v, rawValue] of values.entries()) {
            const value = rawValue as Record<string, unknown>;

            const valueKey = String(value.valueKey ?? '').trim();

            if (seenKeys.has(valueKey)) {
              throw DomainException.validation([
                {
                  field: `document.groups.${g}.options.${o}.values.${v}.valueKey`,
                  code: 'DUPLICATE',
                },
              ]);
            }

            seenKeys.add(valueKey);

            await manager.save(
              manager.create(OptionValue, {
                optionId: optionRow.id,
                valueKey,
                label: String(value.label ?? '').trim(),
                sortOrder: typeof value.sortOrder === 'number' ? value.sortOrder : v * 10,
                /* Checked against the real set; an unknown type falls back to
                 * `fixed`, which is what the column defaults to. */
                priceType: Object.values(PriceType).includes(value.priceType as PriceType)
                  ? (value.priceType as PriceType)
                  : PriceType.FIXED,
                priceAmountMinor:
                  typeof value.priceAmountMinor === 'number' ? value.priceAmountMinor : 0,
                priceConfig: (value.priceConfig ?? null) as never,
                imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : null,
                colorHex: typeof value.colorHex === 'string' ? value.colorHex : null,
                groupLabel: typeof value.groupLabel === 'string' ? value.groupLabel : null,
                skuSuffix: typeof value.skuSuffix === 'string' ? value.skuSuffix : null,
                weightDeltaGrams:
                  typeof value.weightDeltaGrams === 'number' ? value.weightDeltaGrams : null,
                isDefault: value.isDefault === true,
                isEnabled: value.isEnabled !== false,
              }),
            );
          }
        }

        const items = Array.isArray(group.items) ? group.items : [];

        if (items.length > AUTHORING_LIMITS.itemsPerGroup) {
          throw DomainException.validation([
            { field: `document.groups.${g}.items`, code: 'TOO_MANY' },
          ]);
        }

        for (const [i, rawItem] of items.entries()) {
          const item = rawItem as Record<string, unknown>;

          await manager.save(
            manager.create(PresentationalItem, {
              optionGroupId: groupRow.id,
              /*
               * ⚠️ **An unknown kind is REFUSED, not defaulted.** A heading
               * silently becoming a paragraph would change what a customer
               * reads, unlike a layout falling back to `inline` — which the
               * plugin's renderer does anyway.
               */
              kind: (() => {
                if (!Object.values(PresentationalKind).includes(item.kind as PresentationalKind)) {
                  throw DomainException.validation([
                    { field: `document.groups.${g}.items.${i}.kind`, code: 'UNKNOWN_KIND' },
                  ]);
                }

                return item.kind as PresentationalKind;
              })(),
              content: String(item.content ?? ''),
              sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : i * 10,
            }),
          );
        }
      }

      return set;
    });

    await this.audit.record({
      action: AuditAction.OPTION_SET_IMPORTED,
      resourceType: 'option_set',
      resourceId: created.id,
      changes: diff(null, { name: created.name, storeId, status: created.status }),
    });

    return created;
  }

  async duplicate(id: string, name?: string, storeId?: string): Promise<OptionSet> {
    const source = await this.findOne(id);

    /*
     * 🔴 **A named target store is verified against the acting tenant** (M20.8).
     *
     * The id comes from the caller, and the scoped repository stamps the tenant
     * on the new row — so an unchecked target would produce a set that belongs
     * to this tenant while pointing at somebody else's storefront. The same
     * guard `create` uses, for the same reason.
     *
     * ⚠️ **Assignments are not copied**, which is what makes a cross-store copy
     * meaningful rather than broken: they name products by external id, and
     * those ids mean nothing in another store. The copy arrives unassigned.
     */
    if (storeId !== undefined && storeId !== source.storeId) {
      await this.assertStoreBelongsToTenant(storeId);
    }

    const targetStoreId = storeId ?? source.storeId;

    const copy = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(OptionSet, {
          tenantId: source.tenantId,
          storeId: targetStoreId,
          name: name?.trim() || `${source.name} (copy)`,
          status: OptionSetStatus.DRAFT,
          // A copy is unpublished however published its source was.
          version: 0,
          rowVersion: 1,
          publishedConfigVersion: 0,
        }),
      );

      const groups = await manager.find(OptionGroup, {
        where: { optionSetId: source.id, deletedAt: LIVE_SENTINEL_SQL as never },
        order: { sortOrder: 'ASC' },
      });

      /**
       * Source row id -> copied row id, across groups, options and values.
       *
       * Rules target rows by id and name options by id, so a copied rule is
       * meaningless without this. Built as the traversal goes rather than by a
       * second pass, because two traversals of one tree is how `groupLabel` and
       * the presentational items were lost.
       */
      const idMap = new Map<string, string>();

      for (const group of groups) {
        const groupCopy = await manager.save(
          manager.create(OptionGroup, {
            optionSetId: created.id,
            label: group.label,
            description: group.description,
            displayType: group.displayType,
            sortOrder: group.sortOrder,
            isCollapsible: group.isCollapsible,
            // Disabled things stay disabled: a copy that silently enables work
            // the merchant turned off would republish it on the next publish.
            isEnabled: group.isEnabled,
          }),
        );

        /*
         * 🔴 **This block used to re-implement `copyOptionsInto`.**
         *
         * Two traversals of the same tree, and they drifted exactly as that
         * risk predicts: `groupLabel` was added to one value-copy list and not
         * this one, and presentational items were never copied by either — so
         * duplicating a set silently dropped every heading and every
         * `<optgroup>`. Measured before the fix: 1 item in the source, 0 in the
         * copy; `groupLabel` `'Sizes'` became `null`.
         *
         * One call, one traversal, one set of field lists in `duplication.ts`.
         */
        idMap.set(group.id, groupCopy.id);

        for (const [from, to] of await copyOptionsInto(manager, group.id, groupCopy.id)) {
          idMap.set(from, to);
        }
      }

      await copyRulesInto(manager, source.id, created.id, idMap);

      return created;
    });

    await this.audit.record({
      action: AuditAction.OPTION_SET_DUPLICATED,
      resourceType: 'option_set',
      resourceId: copy.id,
      changes: {
        ...diff(null, { name: copy.name, storeId: copy.storeId, status: copy.status }),
        copiedFrom: source.id,
      },
    });

    return copy;
  }

  /**
   * Confirm a store belongs to the acting tenant.
   *
   * A create names its store, and without this a caller could attach an option
   * set to another tenant's storefront — the scoped repository stamps the tenant
   * on the new row, so the set would be theirs while pointing somewhere it should
   * not.
   */
  private async assertStoreBelongsToTenant(storeId: string): Promise<void> {
    const tenantId = getTenantId();

    const [row] = await this.dataSource.query(
      `SELECT 1 AS found FROM stores WHERE id = ? AND tenantId = ? LIMIT 1`,
      [storeId, tenantId],
    );

    if (!row) {
      // "Not found" rather than "forbidden": a store id in another tenant must
      // not be distinguishable from one that does not exist.
      throw DomainException.notFound('Store');
    }
  }
}
