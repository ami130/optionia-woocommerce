import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { diff } from '../audit/audit-diff';
import { AuditAction, AuditService } from '../audit/audit.service';
import { RuleAction, RuleMatchType, RuleTargetType } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import type { ErrorDetail } from '../common/http/api-response.types';
import { OptionRule } from './entities/option-rule.entity';
import { OptionRulesRepository } from './option-rules.repository';
import { OptionSetsRepository } from './option-sets.repository';
import { ParentSetService } from './parent-set';
import { pick } from './entity-patch';
import { codeFor } from './types/option-type.validator';
import { ruleConditionsSchema } from './types/rule-condition.schema';

export interface CreateRuleInput {
  readonly targetType: RuleTargetType;
  readonly targetId: string;
  readonly action: RuleAction;
  readonly matchType: RuleMatchType;
  readonly conditions: unknown[];
  readonly sortOrder?: number;
}

export interface RuleChanges {
  readonly targetType?: RuleTargetType;
  readonly targetId?: string;
  readonly action?: RuleAction;
  readonly matchType?: RuleMatchType;
  readonly conditions?: unknown[];
  readonly sortOrder?: number;
}

/**
 * Authoring conditional rules (M17.1).
 *
 * ## What this service does not decide
 *
 * 🔴 **Nothing here evaluates a rule**, and nothing here checks that the rows a
 * rule points at exist. `targetId` and each condition's `optionId` are validated
 * for *shape* only; whether they name rows **in this set** is a cross-object
 * question needing the whole set loaded, and it belongs with the publish-time
 * check that also detects cycles (M17.3). Two places asking one question is how
 * they come to disagree.
 *
 * 🔴 **A rule edit does not bump `config_version`, and that is correct.** The
 * config document is built from **immutable published snapshots**, so a draft
 * rule is invisible to every storefront until a publish writes a new snapshot.
 * `check-config-invalidation.sh` watches `option_sets` and `option_set_versions`
 * for exactly this reason — its own docblock records that flagging all twenty
 * mutating routes "over-fires by a factor of five", and noise gets exemptions
 * added until a gate means nothing.
 *
 * `ParentSetService.touchSet` still runs, because the *set* changed: its
 * `updatedAt` and `rowVersion` are what optimistic locking and "when did anyone
 * last touch this" depend on.
 */
@Injectable()
export class OptionRulesService {
  constructor(
    private readonly rules: OptionRulesRepository,
    private readonly sets: OptionSetsRepository,
    private readonly parents: ParentSetService,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async listBySet(optionSetId: string): Promise<OptionRule[]> {
    await this.assertSetExists(optionSetId);

    return this.rules.listBySet(optionSetId);
  }

  async findOne(id: string): Promise<OptionRule> {
    const rule = await this.rules.findById(id);

    if (!rule) {
      throw DomainException.notFound('Option rule');
    }

    return rule;
  }

  async create(optionSetId: string, input: CreateRuleInput): Promise<OptionRule> {
    await this.assertSetExists(optionSetId);

    assertWithinLimit(
      await this.rules.countBySet(optionSetId),
      AUTHORING_LIMITS.rulesPerSet,
      'rules',
    );

    const conditions = this.conditionsFor(input.conditions);

    const created = await this.rules.create(optionSetId, {
      optionSetId,
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      matchType: input.matchType,
      conditions,
      sortOrder: input.sortOrder ?? (await this.rules.nextSortOrder(optionSetId)),
      /*
       * A rule is created enabled, and `disabledReason` is null because nothing
       * disabled it. Both are absent from the DTO deliberately: the only reason
       * the system sets them is a deleted target, which the cascade owns.
       */
      isEnabled: true,
      disabledReason: null,
    } as never);

    await this.parents.touchSet(optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_RULE_CREATED,
      resourceType: 'option_rule',
      resourceId: created.id,
      changes: diff(null, {
        targetType: created.targetType,
        targetId: created.targetId,
        action: created.action,
        matchType: created.matchType,
      }),
    });

    return created;
  }

  /**
   * Change what a rule targets, does, or how its conditions combine.
   *
   * ⚠️ **A rule cannot be moved between sets**, so `optionSetId` is not a change
   * this accepts. `targetId` and every condition's `optionId` name rows in the
   * set the rule was created in; carrying them elsewhere produces a rule that
   * evaluates against a document where those ids mean nothing — the defect
   * `copyRulesInto` exists to prevent during duplication, arriving by another
   * door.
   *
   * ⚠️ **`isEnabled` is not accepted either, for now.** The only writer today is
   * the cascade, recording that a target was deleted. A merchant toggle would
   * need to be distinguishable from that — `disabledReason` is exactly the column
   * that distinguishes them — and it is a rule-builder concern (M17.6) rather
   * than a CRUD one. Stated because a silently missing toggle reads as an
   * oversight.
   */
  async update(id: string, changes: RuleChanges): Promise<OptionRule> {
    const before = await this.findOne(id);

    const patch: Partial<OptionRule> = {};

    if (changes.targetType !== undefined) {
      patch.targetType = changes.targetType;
    }

    if (changes.targetId !== undefined) {
      patch.targetId = changes.targetId;
    }

    if (changes.action !== undefined) {
      patch.action = changes.action;
    }

    if (changes.matchType !== undefined) {
      patch.matchType = changes.matchType;
    }

    if (changes.conditions !== undefined) {
      patch.conditions = this.conditionsFor(changes.conditions);
    }

    if (changes.sortOrder !== undefined) {
      patch.sortOrder = changes.sortOrder;
    }

    if (Object.keys(patch).length === 0) {
      return before;
    }

    await this.rules.update({ id } as never, patch as never);
    await this.parents.touchSet(before.optionSetId);

    await this.audit.record({
      action: AuditAction.OPTION_RULE_UPDATED,
      resourceType: 'option_rule',
      resourceId: id,
      changes: diff(pick(before, Object.keys(patch)), patch as Record<string, unknown>),
    });

    return this.findOne(id);
  }

  /**
   * Soft-delete a rule.
   *
   * No cascade call: a rule is a leaf. Nothing targets a rule — `RuleTargetType`
   * is `option | group | value` — so there is no child to disable and no other
   * rule to tell. It is the *targets* that cascade, in the other direction, and
   * `CascadeService` already handles that.
   */
  async remove(id: string): Promise<void> {
    const before = await this.findOne(id);

    await this.rules.update({ id } as never, { deletedAt: new Date() } as never);
    await this.parents.touchSet(before.optionSetId);

    await this.audit.record({
      action: AuditAction.OPTION_RULE_DELETED,
      resourceType: 'option_rule',
      resourceId: id,
      changes: diff(
        { action: before.action, deleted: false },
        { action: before.action, deleted: true },
      ),
    });
  }

  /**
   * Reorder a set's rules.
   *
   * ⚠️ **Order is not precedence, and must not be read as it.** M17.2 requires
   * evaluation to be **order-independent**, and ADR-050 caps the iteration count
   * rather than letting a first-match win. `sortOrder` decides what a merchant
   * sees in the rule list, which matters for M17.6's plain-language summaries and
   * nothing else. Stated here because a `sortOrder` on a rule invites exactly the
   * wrong assumption.
   */
  async reorder(
    optionSetId: string,
    entries: ReadonlyArray<{ id: string; sortOrder: number }>,
  ): Promise<OptionRule[]> {
    await this.assertSetExists(optionSetId);

    const siblings = await this.rules.listBySet(optionSetId);
    const known = new Set(siblings.map((rule) => rule.id));
    const unknown = entries.filter((entry) => !known.has(entry.id));

    if (unknown.length > 0) {
      throw DomainException.validation(
        unknown.map((entry, index) => ({
          field: `rules.${index}.id`,
          code: 'NOT_IN_SET',
          params: { message: `Option rule ${entry.id} does not belong to this option set.` },
        })),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const entry of entries) {
        await manager.update(OptionRule, { id: entry.id }, { sortOrder: entry.sortOrder });
      }
    });

    await this.parents.touchSet(optionSetId);
    await this.audit.record({
      action: AuditAction.OPTION_RULE_REORDERED,
      resourceType: 'option_set',
      resourceId: optionSetId,
      changes: {
        rules: {
          from: siblings.map((rule) => ({ id: rule.id, sortOrder: rule.sortOrder })),
          to: entries.map((entry) => ({ id: entry.id, sortOrder: entry.sortOrder })),
        },
      },
    });

    return this.rules.listBySet(optionSetId);
  }

  /**
   * Validate the condition list, and return it in the shape the column stores.
   *
   * 🔴 **Run here rather than through `OptionTypeValidator.check`, which returns
   * no errors for `undefined` or `null`.** That behaviour is right where it lives
   * — a database row carrying `validation: null` must not fail, and all 45 seeded
   * options did before that rule existed — and wrong here: a rule with no
   * conditions **always fires**, so absence is the error rather than a permission
   * to skip checking.
   *
   * The DTO's `@ArrayNotEmpty()` is the first line and this is the second, for
   * the reason AC4 gives everywhere else: a shape check and a content check are
   * different questions, and the caller of a service is not always a controller.
   */
  private conditionsFor(raw: unknown): Record<string, unknown>[] {
    const result = ruleConditionsSchema.safeParse(raw);

    if (!result.success) {
      throw DomainException.validation(
        result.error.issues.map(
          (issue): ErrorDetail => ({
            /* Dotted, so a dashboard can point at the offending condition. */
            field: ['conditions', ...issue.path.map(String)].join('.'),
            code: codeFor(issue),
            params: { message: issue.message },
          }),
        ),
      );
    }

    return result.data as Record<string, unknown>[];
  }

  private async assertSetExists(optionSetId: string): Promise<void> {
    if (!(await this.sets.findById(optionSetId))) {
      throw DomainException.notFound('Option set');
    }
  }
}
