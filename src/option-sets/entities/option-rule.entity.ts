import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import {
  RuleAction,
  type RuleDisabledReason,
  RuleMatchType,
  RuleTargetType,
} from '../../common/database/enums';
import { OptionSet } from './option-set.entity';

/**
 * Conditional logic: IF <conditions> THEN <action> ON <target>.
 *
 * A reusable rule engine rather than hardcoded cases — the difference between
 * "show engraving text when engraving = yes" being data and being code.
 */
@Entity('option_rules')
@Index('ix_option_rules_set_enabled', ['optionSetId', 'isEnabled'])
export class OptionRule extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionSetId: string;

  @ManyToOne(() => OptionSet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionSetId' })
  optionSet: OptionSet;

  @Column({ type: 'varchar', length: 20 })
  targetType: RuleTargetType;

  /**
   * The targeted option, group or value.
   *
   * Deliberately **not** a foreign key: the target is polymorphic across three
   * tables, and a rule whose target is deleted must survive long enough to be
   * flagged rather than cascading away silently.
   */
  @Column({ type: 'char', length: 36 })
  targetId: string;

  @Column({ type: 'varchar', length: 20 })
  action: RuleAction;

  /**
   * The conditions, as a flat list.
   *
   * JSON because a list of heterogeneous comparisons has no useful relational
   * shape. Validated by `ruleConditionsSchema`, and checked for cycles at publish
   * time rather than discovered at customer request time.
   *
   * ✏️ **Typed `Record<string, unknown>` and described as "nested groups" until
   * Stage 17-1.** Both were placeholders written before M17.1 was implemented,
   * and both were wrong: M17.1 specifies `IF <conditions, matched ALL|ANY>` —
   * **one list and one connective**, not a tree. The array type is what
   * `ruleConditionsSchema` actually produces, and the mismatch surfaced as a
   * compile error the first time a rule was copied.
   *
   * ⚠️ **`matchType` is the sibling column below, deliberately not a key in
   * here.** One fact, one home.
   */
  @Column({ type: 'json' })
  conditions: Record<string, unknown>[];

  @Column({ type: 'varchar', length: 10, default: RuleMatchType.ALL })
  matchType: RuleMatchType;

  /**
   * What the action acts **with**, for the actions that need one.
   *
   * 🔴 **Absent until M17.4, and three of six actions were unimplementable
   * without it.** `set_price` had no amount to set and `set_default` no value to
   * write — the entity, the DTOs and `PublishedRule` all omitted it and all
   * agreed with each other, so nothing noticed until an evaluator was designed
   * against the shape rather than the prose.
   *
   * | Action | Payload |
   * |---|---|
   * | `set_price` | `{ amountMinor }` — an integer, as money is everywhere (ADR-013) |
   * | `set_default` | `{ valueKey }` — the value to preselect |
   * | `show` · `hide` · `require` · `unrequire` | **none** — the action says everything |
   *
   * Null for the four that need nothing, rather than `{}`: absence is the normal
   * case, and an empty object is a second thing a reader must tell apart from a
   * missing one.
   *
   * ⚠️ **`amountMinor` is a REPLACEMENT, not an addition** (ADR-049). A merchant
   * writing "set price to 5.00" means the price *is* 5.00 — which is also the
   * only reading that is idempotent, and therefore the only one compatible with
   * M17.2's order-independence.
   */
  @Column({ type: 'json', nullable: true })
  actionValue: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /**
   * A rule whose target was deleted is **disabled and surfaced to the merchant**,
   * never silently dropped and never left to fail at evaluation time.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;

  /**
   * Why the system disabled this rule, or `null` when the merchant did.
   *
   * `isEnabled` alone cannot tell those apart, and the difference is the whole
   * promise: a merchant who turned a rule off knows where it is, while one whose
   * rule was disabled because its target was deleted needs to be told which
   * target and why. Without this column "surfaced to the merchant" is a comment
   * rather than something the dashboard can render.
   *
   * Set when a cascade disables the rule; cleared when a merchant re-enables it.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  disabledReason: RuleDisabledReason | null;
}
