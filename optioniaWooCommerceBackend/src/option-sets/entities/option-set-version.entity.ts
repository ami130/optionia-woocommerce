import { Column, Entity, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { OptionSet } from './option-set.entity';
import { User } from '../../users/entities/user.entity';

/**
 * An immutable snapshot of a published option set.
 *
 * Never updated, never soft-deleted. Rollback publishes a prior snapshot as a
 * **new** version rather than rewriting history — so "what was live last Tuesday"
 * stays answerable, which matters when a merchant disputes what a customer was
 * charged.
 *
 * Created in Phase 5 though nothing writes to it until M7.4 (ADR-017): adding a
 * table later is a migration, and verifying one against an empty database is
 * cheaper than against merchant data.
 */
@Entity('option_set_versions')
@Unique('uq_option_set_versions', ['optionSetId', 'version'])
export class OptionSetVersion extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  optionSetId: string;

  @ManyToOne(() => OptionSet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionSetId' })
  optionSet: OptionSet;

  @Column({ type: 'int' })
  version: number;

  /** The complete published document, exactly as the plugin received it. */
  @Column({ type: 'json' })
  snapshot: Record<string, unknown>;

  /** `SET NULL`: the snapshot outlives the person who published it. */
  @Column({ type: 'char', length: 36, nullable: true })
  publishedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'publishedBy' })
  publisher: User | null;

  @Column({ type: 'datetime', precision: 3 })
  publishedAt: Date;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;
}
