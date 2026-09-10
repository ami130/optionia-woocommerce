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
import { OptionGroupsRepository } from './option-groups.repository';
import { OptionSetsRepository } from './option-sets.repository';
import { OptionValuesRepository } from './option-values.repository';
import { OptionsRepository } from './options.repository';
import { ParentSetService } from './parent-set';
import { pick } from './entity-patch';
import { codeFor } from './types/option-type.validator';
import {
  ACTIONS_REQUIRING_A_VALUE,
  ruleActionValueSchema,
  ruleConditionsSchema,
} from './types/rule-condition.schema';

export interface CreateRuleInput {
  readonly targetType: RuleTargetType;
  readonly targetId: string;
  readonly action: RuleAction;
  readonly matchType: RuleMatchType;
  readonly conditions: unknown[];
  readonly actionValue?: Record<string, unknown>;
  readonly sortOrder?: number;
}

export interface RuleChanges {
  readonly targetType?: RuleTargetType;
  readonly targetId?: string;
  readonly action?: RuleAction;
  readonly matchType?: RuleMatchType;
  readonly conditions?: unknown[];
  readonly actionValue?: Record<string, unknown>;
  readonly sortOrder?: number;
}

/**
 * Authoring conditional rules (M17.1).
 *
 * ## What this service does not decide
 *
 * 🔴 **Nothing here evaluates a rule.** What it does check, and what it leaves
 * to M17.3, is a deliberate split along one line — **can a single row answer
 * it?**
 *
 * | Question | Where |
 * |---|---|
 * | Is `targetId` a UUID at all? | the DTO |
 * | Does that row exist, and is it the kind claimed? | **here** — one scoped read |
 * | Is it in *this* option set? | M17.3, at publish |
 * | Do the rules form a cycle? | M17.3, at publish |
 *
 * The middle row lives here because of a consequence the outer two do not have:
 * `CascadeService` disables an orphaned rule by matching `targetType` **and**
 * `targetId` together, so a mismatched pair is swept by neither branch and is
 * never flagged `TARGET_DELETED`. Deferring that check would leave a rule that
 * governs nothing, for ever, while looking authored.
 *
 * ⚠️ **A cross-set target is accepted here, and that is a known gap rather than
 * an oversight.** A rule in set A may point at set B's option: it passes this
 * check (the row exists and is an option) and is refused only at publish. Until
 * then the builder shows it as valid — and the cascade will not disable it when
 * B's option is deleted, because a cascade sweeps within the deleted row's own
 * set. Stated in `developePlan.md` under 17-2 so M17.3 designs for it.
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
    private readonly groups: OptionGroupsRepository,
    private readonly options: OptionsRepository,
    private readonly values: OptionValuesRepository,
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
    const actionValue = this.actionValueFor(input.action, input.actionValue);

    await this.assertTargetIsWhatItClaims(input.targetType, input.targetId);

    const created = await this.rules.create(optionSetId, {
      optionSetId,
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      matchType: input.matchType,
      conditions,
      actionValue,
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

    /*
     * 🔴 **Re-checked whenever EITHER half moves.** Changing `action` alone from
     * `set_price` to `hide` leaves an amount behind that nothing will read, and
     * changing it the other way leaves a rule with no amount to set. Validating
     * only the field that arrived would miss both.
     */
    if (changes.action !== undefined || changes.actionValue !== undefined) {
      patch.actionValue = this.actionValueFor(
        changes.action ?? before.action,
        changes.actionValue ?? before.actionValue ?? undefined,
      );
    }

    if (Object.keys(patch).length === 0) {
      return before;
    }

    /*
     * Checked against the resulting pair, not the changed field alone. A PATCH
     * altering only `targetType` re-points the rule at a different *kind* of row
     * while keeping the old id — which is exactly the mismatch this refuses, and
     * checking only what changed would miss it.
     */
    if (patch.targetType !== undefined || patch.targetId !== undefined) {
      await this.assertTargetIsWhatItClaims(
        patch.targetType ?? before.targetType,
        patch.targetId ?? before.targetId,
      );
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
   * Refuse a target that does not exist, or is not the kind the rule claims.
   *
   * 🔴 **A mismatch is permanent and silent, which is why shape validation is
   * not enough.** `CascadeService` disables an orphaned rule by matching
   * `targetType` **and** `targetId` together:
   *
   * ```ts
   * { targetType: target.type, targetId: In(target.ids), … }
   * ```
   *
   * So a rule claiming `option` while pointing at a **value** id is swept by
   * neither branch — the option pass never sees that id, and the value pass
   * never sees that type. When the value is deleted the rule is **not** disabled
   * and **not** flagged `TARGET_DELETED`; it simply governs nothing, for ever,
   * while looking authored in the builder.
   *
   * Measured before this check: `targetType: 'option'` with a value's id was
   * accepted with a 201.
   *
   * ⚠️ **This is a different question from "is the target in this set".** That
   * one needs the whole set loaded and belongs to the publish-time check with
   * cycle detection (M17.3) — see the class docblock. This is the narrower
   * question a single row can answer, and answering it here is what keeps the
   * cascade's guarantee true.
   *
   * ⚠️ **Scoped, so it doubles as a tenancy check.** Each repository joins to
   * `option_sets` and filters on the tenant, so a target belonging to another
   * tenant reads as *not found* rather than leaking its existence.
   */
  private async assertTargetIsWhatItClaims(
    targetType: RuleTargetType,
    targetId: string,
  ): Promise<void> {
    const exists = await this.targetExists(targetType, targetId);

    if (!exists) {
      throw DomainException.validation([
        {
          field: 'targetId',
          code: 'TARGET_NOT_FOUND',
          params: {
            message: `No ${targetType} with id ${targetId} exists, so this rule could never apply.`,
            targetType,
          },
        },
      ]);
    }
  }

  private async targetExists(targetType: RuleTargetType, targetId: string): Promise<boolean> {
    switch (targetType) {
      case RuleTargetType.GROUP:
        return (await this.groups.findById(targetId)) !== null;
      case RuleTargetType.OPTION:
        return (await this.options.findById(targetId)) !== null;
      case RuleTargetType.VALUE:
        return (await this.values.findById(targetId)) !== null;
      /*
       * No `default`. `RuleTargetType` is a closed union, so a new member is a
       * compile error here rather than a target that silently validates —
       * `RuleTargetType` gaining `item` is a real prospect, since M5.4c gives
       * presentational items conditional visibility.
       */
    }
  }

  /**
   * Validate the action's payload against the action that will use it.
   *
   * 🔴 **Three of six actions were unimplementable before this column existed.**
   * `set_price` had no amount to set and `set_default` no value to write, while
   * ADR-049 reasoned in detail about what `set_price` means. The reasoning was
   * sound; the schema could not carry it.
   *
   * ⚠️ **Refusing a payload the action cannot use is half the point.** An
   * `amountMinor` on a `hide` rule stores a number nothing will ever read — the
   * `freeUnits: 5` shape Phase 16 measured, where a setting saved successfully,
   * was charged as absent, and the merchant had no way to tell.
   */
  private actionValueFor(
    action: RuleAction,
    raw: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    if (ACTIONS_REQUIRING_A_VALUE.includes(action) && raw === undefined) {
      throw DomainException.validation([
        {
          field: 'actionValue',
          code: 'REQUIRED',
          params: { message: `A ${action} rule needs a value to act with.` },
        },
      ]);
    }

    const result = ruleActionValueSchema(action).safeParse(raw);

    if (!result.success) {
      throw DomainException.validation(
        result.error.issues.map(
          (issue): ErrorDetail => ({
            field: ['actionValue', ...issue.path.map(String)].join('.'),
            code: codeFor(issue),
            params: { message: issue.message },
          }),
        ),
      );
    }

    return (result.data as Record<string, unknown> | undefined) ?? null;
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
