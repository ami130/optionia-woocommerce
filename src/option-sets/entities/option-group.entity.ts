import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { GroupDisplayType } from '../../common/database/enums';
import { OptionSet } from './option-set.entity';

/**
 * A section within an option set.
 *
 * Groups exist because a made-to-order product form with twelve options is
 * unusable without sections — this is what makes a complex option set
 * comprehensible to a customer, not decoration.
 */
@Entity('option_groups')
@Index('ix_option_groups_set_order', ['optionSetId', 'sortOrder'])
export class OptionGroup extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionSetId: string;

  @ManyToOne(() => OptionSet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionSetId' })
  optionSet: OptionSet;

  @Column({ type: 'varchar', length: 160 })
  label: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20, default: GroupDisplayType.INLINE })
  displayType: GroupDisplayType;

  /**
   * Gap-tolerant integers, so moving one item is a single write rather than a
   * renumber of everything after it.
   */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: false })
  isCollapsible: boolean;

  /**
   * Whether this group appears in the published config.
   *
   * **A soft toggle, and deliberately not soft delete.** M7.2 lists them as
   * separate operations because they mean different things: deleting hides
   * something permanently and is a cleanup action, disabling is reversible and is
   * expected to be undone. `deleted_at` cannot express "turn this off for the
   * holidays without losing the work".
   *
   * Disabled rows are retained in full — their options and values survive, so re-enabling
   * restores exactly what was there rather than an empty shell.
   *
   * Defaults to enabled: something a merchant just created is something they want
   * live, and requiring an extra click to publish new work would be surprising.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;
}
