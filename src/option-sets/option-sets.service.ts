import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { getTenantId } from '../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { OptionSetStatus } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroup } from './entities/option-group.entity';
import { OptionSet } from './entities/option-set.entity';
import { OptionValue } from './entities/option-value.entity';
import { Option } from './entities/option.entity';
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
      cascaded = await this.cascade.onOptionSetDeleted(id, deletedAt);
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
  async duplicate(id: string, name?: string): Promise<OptionSet> {
    const source = await this.findOne(id);

    const copy = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(OptionSet, {
          tenantId: source.tenantId,
          storeId: source.storeId,
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

        const options = await manager.find(Option, {
          where: { optionGroupId: group.id, deletedAt: LIVE_SENTINEL_SQL as never },
          order: { sortOrder: 'ASC' },
        });

        for (const option of options) {
          const optionCopy = await manager.save(
            manager.create(Option, {
              optionGroupId: groupCopy.id,
              // The key is copied, not regenerated: it is unique per *group*,
              // and this is a new group. A merchant expects the copy to look
              // like the original, and a mangled key would show in the config
              // document the plugin reads.
              key: option.key,
              valueKind: option.valueKind,
              cardinality: option.cardinality,
              presentation: option.presentation,
              label: option.label,
              description: option.description,
              placeholder: option.placeholder,
              helpText: option.helpText,
              isRequired: option.isRequired,
              sortOrder: option.sortOrder,
              defaultValue: option.defaultValue,
              validation: option.validation,
              pricing: option.pricing,
              display: option.display,
              isEnabled: option.isEnabled,
            }),
          );

          const values = await manager.find(OptionValue, {
            where: { optionId: option.id, deletedAt: LIVE_SENTINEL_SQL as never },
            order: { sortOrder: 'ASC' },
          });

          if (values.length > 0) {
            await manager.save(
              values.map((value) =>
                manager.create(OptionValue, {
                  optionId: optionCopy.id,
                  valueKey: value.valueKey,
                  label: value.label,
                  sortOrder: value.sortOrder,
                  priceType: value.priceType,
                  priceAmountMinor: value.priceAmountMinor,
                  priceConfig: value.priceConfig,
                  imageUrl: value.imageUrl,
                  colorHex: value.colorHex,
                  skuSuffix: value.skuSuffix,
                  weightDeltaGrams: value.weightDeltaGrams,
                  isDefault: value.isDefault,
                  isEnabled: value.isEnabled,
                }),
              ),
            );
          }
        }
      }

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
