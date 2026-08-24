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
}
