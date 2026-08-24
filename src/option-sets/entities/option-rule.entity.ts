import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { RuleAction, RuleMatchType, RuleTargetType } from '../../common/database/enums';
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
   * The condition tree.
   *
   * JSON because the shape is arbitrary — nested groups of comparisons against
   * other options' values. Validated by a versioned Zod schema, and checked for
   * cycles at publish time rather than discovered at customer request time.
   */
  @Column({ type: 'json' })
  conditions: Record<string, unknown>;

  @Column({ type: 'varchar', length: 10, default: RuleMatchType.ALL })
  matchType: RuleMatchType;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /**
   * A rule whose target was deleted is **disabled and surfaced to the merchant**,
   * never silently dropped and never left to fail at evaluation time.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;
}
