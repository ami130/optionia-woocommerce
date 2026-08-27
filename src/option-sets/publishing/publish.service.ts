import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { diff } from '../../audit/audit-diff';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { getUserId } from '../../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../../common/database/base.entity';
import { OptionSetStatus } from '../../common/database/enums';
import { DomainException } from '../../common/errors/domain.exception';
import { assertVersionMatches } from '../optimistic-lock';
import { OptionRule } from '../entities/option-rule.entity';
import { OptionSetAssignment } from '../entities/option-set-assignment.entity';
import { OptionSetVersion } from '../entities/option-set-version.entity';
import { OptionSet } from '../entities/option-set.entity';
import { Store } from '../../stores/entities/store.entity';
import { OptionSetTreeLoader } from '../serialization/option-set-tree.loader';
import { OptionSetSerializer } from '../serialization/option-set.serializer';
import {
  hasBlockers,
  runPublishChecks,
  type PublishContext,
  type PublishFinding,
} from './publish-check';

/** What a publish produced. */
export interface PublishResult {
  readonly version: number;
  readonly publishedAt: string;
  readonly configVersion: number;
  /** Warnings that did not block. A merchant should see them after the fact too. */
  readonly warnings: readonly PublishFinding[];
}

/** One entry in the version history. */
export interface VersionSummary {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string | null;
  readonly note: string | null;
}

/**
 * Publish, version history and rollback (M7.4).
 *
 * ## Why publish is one transaction
 *
 * Publishing does five things: validate, increment `version`, stamp
 * `published_at` / `published_by`, write an immutable snapshot, and bump the
 * store's `config_version`. Split across statements, a failure between any two
 * leaves a set claiming a version whose snapshot does not exist, or a store
 * advertising a config version nothing produced — and the plugin polls that
 * number to decide whether to re-fetch. A storefront would ask for a document
 * that was never written.
 *
 * ## Why an edit does not reach a storefront
 *
 * A published set holds a published version *and* a working draft. The snapshot
 * is what a storefront reads; the live rows are what the merchant edits. That is
 * the whole point of the draft state and the thing a self-hosted plugin cannot
 * offer — a merchant edits safely on a live store.
 */
@Injectable()
export class PublishService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly trees: OptionSetTreeLoader,
    private readonly serializer: OptionSetSerializer,
    private readonly audit: AuditService,
  ) {}

  /**
   * What would block or warn, without publishing.
   *
   * Surfaced *before* the button, per M7.4: a merchant who clicks publish and
   * gets a list of errors has already committed to the act, and the list reads
   * as a failure rather than as work to do.
   */
  async check(optionSetId: string): Promise<readonly PublishFinding[]> {
    return runPublishChecks(await this.context(optionSetId));
  }

  async publish(
    optionSetId: string,
    note?: string,
    expectedRowVersion?: number,
  ): Promise<PublishResult> {
    const context = await this.context(optionSetId);

    /**
     * Publishing a draft that changed since it was loaded (M7.4b).
     *
     * The stakes are higher than a rename: publish takes whatever the set
     * currently contains and puts it in front of customers. A merchant who
     * reviewed a draft, and whose colleague then changed it, would publish work
     * they never saw.
     *
     * Checked here rather than inside the transaction so the answer names what
     * is wrong before the expensive serialization runs. The lock taken in the
     * transaction is what stops two publishes interleaving; this is what stops
     * one publishing a draft its author had not read.
     */
    assertVersionMatches(context.tree.set.rowVersion, expectedRowVersion);

    const findings = runPublishChecks(context);

    if (hasBlockers(findings)) {
      throw DomainException.validation(
        findings
          .filter((finding) => finding.severity === 'blocker')
          .map((finding) => ({
            field: finding.subject,
            code: finding.code,
            params: { message: finding.message },
          })),
      );
    }

    // Serialized **outside** the transaction: reading the tree is the expensive
    // part, and holding a row lock across it would make two merchants publishing
    // different sets on one store wait for each other.
    const snapshot = this.serializer.toPublished(context.tree);
    const publishedBy = getUserId();

    const result = await this.dataSource.transaction(async (manager) => {
      const set = await this.lockSet(manager, optionSetId);
      const version = set.version + 1;
      const publishedAt = new Date();

      await manager.save(
        // `save` rather than `insert`: ids come from an `@BeforeInsert` hook,
        // which `insert` bypasses — it writes the literal given to it.
        manager.create(OptionSetVersion, {
          optionSetId,
          version,
          // The snapshot is what a storefront reads. It is written once and
          // never updated — a rollback publishes a copy as a new version rather
          // than editing this one, so history stays true.
          snapshot: { ...snapshot, version },
          publishedBy,
          publishedAt,
          note: note?.trim() || null,
        }),
      );

      const configVersion = await this.bumpStoreConfigVersion(manager, set.storeId);

      await manager.update(
        OptionSet,
        { id: optionSetId },
        {
          status: OptionSetStatus.PUBLISHED,
          version,
          publishedAt,
          publishedBy,
          publishedConfigVersion: configVersion,
          rowVersion: () => 'rowVersion + 1',
        } as never,
      );

      return { version, publishedAt, configVersion };
    });

    await this.audit.record({
      action: AuditAction.OPTION_SET_PUBLISHED,
      resourceType: 'option_set',
      resourceId: optionSetId,
      changes: {
        ...diff({ version: context.tree.set.version }, { version: result.version }),
        configVersion: result.configVersion,
        /**
         * **Which** warnings, not how many.
         *
         * A count answers "were there any?"; support is asked "did anyone know
         * this set was assigned to nothing when it went live?" — and that needs
         * the codes. The messages are omitted: they are English, they change,
         * and the code is the stable fact.
         */
        warnings: findings.map((finding) => ({
          code: finding.code,
          subject: finding.subject,
        })),
      },
    });

    return {
      version: result.version,
      publishedAt: result.publishedAt.toISOString(),
      configVersion: result.configVersion,
      warnings: findings,
    };
  }

  /** The version history, newest first. Snapshots are omitted — they are large. */
  async versions(optionSetId: string): Promise<readonly VersionSummary[]> {
    // Resolves the set through the scoped repository first, so a foreign id is a
    // 404 before any version is read.
    await this.trees.load(optionSetId);

    const rows = await this.dataSource.getRepository(OptionSetVersion).find({
      where: { optionSetId },
      order: { version: 'DESC' },
      select: { version: true, publishedAt: true, publishedBy: true, note: true },
    });

    return rows.map((row) => ({
      version: row.version,
      publishedAt: row.publishedAt.toISOString(),
      publishedBy: row.publishedBy,
      note: row.note,
    }));
  }

  /** One historical snapshot, as the storefront received it. */
  async version(optionSetId: string, version: number): Promise<Record<string, unknown>> {
    await this.trees.load(optionSetId);

    const row = await this.dataSource.getRepository(OptionSetVersion).findOne({
      where: { optionSetId, version },
    });

    if (!row) {
      throw DomainException.notFound('Version');
    }

    return row.snapshot;
  }

  /**
   * Publish a prior snapshot as a **new** version.
   *
   * Rolling version 8 back to 5 produces version 9 whose content matches 5.
   * Rewriting history would make the trail a lie, and the merchant who needs
   * rollback at 9pm is exactly the one who will later need to know what
   * happened.
   *
   * ⚠️ **The live rows are not restored.** Rollback changes what storefronts
   * receive, not what the editor shows — those are different things, and a
   * rollback that silently overwrote a merchant's working draft would destroy
   * the edits they were making when they hit the problem.
   */
  async rollback(
    optionSetId: string,
    version: number,
    note?: string,
    expectedRowVersion?: number,
  ): Promise<PublishResult> {
    /**
     * The optimistic lock matters **most** here (M7.4b).
     *
     * Rollback changes what every storefront receives, and a merchant chooses a
     * version from a history list. If that list is stale — a colleague published
     * while it was on screen — the merchant reverts based on something that is
     * no longer true, and the version numbers they were reading have moved.
     *
     * Checked before the snapshot is read, so a stale request costs nothing.
     */
    assertVersionMatches((await this.trees.load(optionSetId)).set.rowVersion, expectedRowVersion);

    const snapshot = await this.version(optionSetId, version);

    const result = await this.dataSource.transaction(async (manager) => {
      const set = await this.lockSet(manager, optionSetId);
      const nextVersion = set.version + 1;
      const publishedAt = new Date();
      const publishedBy = getUserId();

      await manager.save(
        manager.create(OptionSetVersion, {
          optionSetId,
          version: nextVersion,
          snapshot: { ...snapshot, version: nextVersion },
          publishedBy,
          publishedAt,
          note: note?.trim() || `Rolled back to version ${version}.`,
        }),
      );

      const configVersion = await this.bumpStoreConfigVersion(manager, set.storeId);

      await manager.update(
        OptionSet,
        { id: optionSetId },
        {
          status: OptionSetStatus.PUBLISHED,
          version: nextVersion,
          publishedAt,
          publishedBy,
          publishedConfigVersion: configVersion,
          rowVersion: () => 'rowVersion + 1',
        } as never,
      );

      return { version: nextVersion, publishedAt, configVersion };
    });

    await this.audit.record({
      action: AuditAction.OPTION_SET_ROLLED_BACK,
      resourceType: 'option_set',
      resourceId: optionSetId,
      changes: {
        ...diff({ version: null }, { version: result.version }),
        restoredFrom: version,
        configVersion: result.configVersion,
      },
    });

    return {
      version: result.version,
      publishedAt: result.publishedAt.toISOString(),
      configVersion: result.configVersion,
      warnings: [],
    };
  }

  /**
   * Take the set's row for update, and confirm it is this tenant's.
   *
   * **Publish is serialized per option set** (M7.4b): two simultaneous publishes
   * must not interleave into a half-built snapshot, and the second must see the
   * first's version rather than reusing it. The lock is what orders them; the
   * `uq_option_set_versions` constraint is the backstop if it ever does not.
   *
   * Scoping is re-stated here because this reads through the manager rather than
   * the scoped repository — the tenant was already established by `context()`,
   * and this refuses again rather than trusting that.
   */
  private async lockSet(manager: EntityManager, optionSetId: string): Promise<OptionSet> {
    const set = await manager
      .createQueryBuilder(OptionSet, 's')
      .setLock('pessimistic_write')
      .where('s.id = :id', { id: optionSetId })
      .andWhere('s.deletedAt = :liveSentinel', { liveSentinel: LIVE_SENTINEL_SQL })
      .getOne();

    if (!set) {
      throw DomainException.notFound('Option set');
    }

    return set;
  }

  /**
   * Advance the store's config version and return the new value.
   *
   * The plugin polls this number to decide whether to re-fetch. Computed in SQL
   * rather than read-then-written, so two sets publishing to one store cannot
   * land on the same number and leave one document unreachable.
   */
  private async bumpStoreConfigVersion(
    manager: EntityManager,
    storeId: string,
  ): Promise<number> {
    await manager
      .createQueryBuilder()
      .update(Store)
      .set({ configVersion: () => 'configVersion + 1' } as never)
      .where('id = :id', { id: storeId })
      .execute();

    const store = await manager.findOne(Store, { where: { id: storeId } });

    return Number(store?.configVersion ?? 0);
  }

  /** Everything the checks need, loaded once. */
  private async context(optionSetId: string): Promise<PublishContext> {
    const tree = await this.trees.load(optionSetId);

    const rules = await this.dataSource.getRepository(OptionRule).find({
      where: { optionSetId, deletedAt: LIVE_SENTINEL_SQL as never },
    });

    const assignments = await this.dataSource.getRepository(OptionSetAssignment).find({
      where: { optionSetId, deletedAt: LIVE_SENTINEL_SQL as never },
      select: { id: true },
    });

    return { tree, rules, assignments };
  }
}
