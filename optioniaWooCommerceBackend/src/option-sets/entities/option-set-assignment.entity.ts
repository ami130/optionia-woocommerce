import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { AssignmentMode, AssignmentTargetType } from '../../common/database/enums';
import { OptionSet } from './option-set.entity';

/**
 * How an option set reaches products.
 *
 * `CONDITIONAL` is materially different from `MANUAL`: a product created next
 * month that matches the rule inherits the set with **no merchant action**,
 * whereas a manual list silently goes stale. For a merchant adding products
 * weekly that is the difference between the option set working and quietly not.
 *
 * Conditional rules resolve **in the cloud at publish time** into a materialized
 * product list — never evaluated in the plugin at render time, which would put a
 * matcher on every product page and violate AC3.
 */
@Entity('option_set_assignments')
@Index('ix_assignments_set_mode', ['optionSetId', 'mode'])
@Index('ix_assignments_target', ['targetType', 'targetRef'])
/**
 * One assignment per set, per target (finding **A1**).
 *
 * `deletedAt` is in the key because these rows are soft-deleted: without it,
 * re-assigning a product a merchant had previously unassigned would collide with
 * its own tombstone. Live rows share the sentinel, so uniqueness among them is
 * what this enforces.
 *
 * **`ALL` assignments are not covered**: their target columns are NULL, and MySQL
 * treats NULLs as distinct in a unique index. M13.6 authors only `MANUAL`, so
 * the gap is known rather than accidental.
 */
@Unique('uq_assignments_set_target', ['optionSetId', 'targetType', 'targetRef', 'deletedAt'])
export class OptionSetAssignment extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionSetId: string;

  @ManyToOne(() => OptionSet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionSetId' })
  optionSet: OptionSet;

  @Column({ type: 'varchar', length: 20 })
  mode: AssignmentMode;

  @Column({ type: 'varchar', length: 20, nullable: true })
  targetType: AssignmentTargetType | null;

  /** External id, slug or range expression, depending on `targetType`. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  targetRef: string | null;

  /** Condition tree for `CONDITIONAL` mode. */
  @Column({ type: 'json', nullable: true })
  matchRules: Record<string, unknown> | null;

  /**
   * Resolution order when a product matches several sets.
   *
   * Assignment is exclusive per set, but a product can match one `all` set and
   * one `conditional` set at once — so ordering must be deterministic rather
   * than incidental.
   */
  @Column({ type: 'int', default: 0 })
  priority: number;
}
