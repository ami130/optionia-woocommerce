import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';
import { OptionGroup } from './option-group.entity';

/**
 * A single configurable choice on a product.
 *
 * **Three orthogonal axes, not one type enum** (M5.4b):
 *
 * ```text
 * valueKind     what sort of value it produces   none|text|number|date|file|choice
 * cardinality   how many may be selected         none|one|many
 * presentation  how it is drawn                  radio|dropdown|color_swatch|…
 * ```
 *
 * A single-select and a multi-select colour swatch are therefore **one type with
 * a different cardinality**, not two types. Modelled as a flat enum they would
 * duplicate the renderer, the validator and the pricing path.
 */
@Entity('options')
@Unique('uq_options_group_key', ['optionGroupId', 'key', 'deletedAt'])
@Index('ix_options_group_order', ['optionGroupId', 'sortOrder'])
export class Option extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionGroupId: string;

  @ManyToOne(() => OptionGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionGroupId' })
  optionGroup: OptionGroup;

  /**
   * Stable, merchant-facing identifier. **Immutable after first publish.**
   *
   * Order item meta stores this key, so a rename would make every historic order
   * unreadable — the merchant would see a selection they cannot map to anything.
   * Labels are free to change because they are snapshotted per order.
   *
   * The unique constraint includes `deletedAt` so a key can be reused after the
   * option holding it is deleted. That works only because `deletedAt` is
   * `NOT NULL` with a sentinel default — with a nullable column MySQL treats
   * every live row as distinct and permits unlimited duplicates. See ADR-014.
   */
  @Column({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'varchar', length: 20 })
  valueKind: ValueKind;

  @Column({ type: 'varchar', length: 10 })
  cardinality: Cardinality;

  @Column({ type: 'varchar', length: 30 })
  presentation: Presentation;

  @Column({ type: 'varchar', length: 200 })
  label: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  placeholder: string | null;

  /**
   * Persistent guidance shown under the field.
   *
   * Associated with the input via `aria-describedby` on the storefront, so it
   * reaches screen-reader users rather than only sighted ones (M29.7b).
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  helpText: string | null;

  @Column({ type: 'boolean', default: false })
  isRequired: boolean;

  /**
   * Whether this option appears in the published config.
   *
   * **A soft toggle, and deliberately not soft delete.** M7.2 lists them as
   * separate operations because they mean different things: deleting hides
   * something permanently and is a cleanup action, disabling is reversible and is
   * expected to be undone. `deleted_at` cannot express "turn this off for the
   * holidays without losing the work".
   *
   * Disabled rows are retained in full — their values survive, so re-enabling
   * restores exactly what was there rather than an empty shell.
   *
   * Defaults to enabled: something a merchant just created is something they want
   * live, and requiring an extra click to publish new work would be surprising.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /**
   * Pre-selected value.
   *
   * Interacts with `isRequired`: a required option carrying a default can never
   * fail validation, which changes what "required" means. Resolved deliberately
   * — a default satisfies required, and the builder tells merchants so.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  defaultValue: string | null;

  /**
   * Per-type validation rules — min/max length for text, blackout dates for a
   * date picker, allowed MIME types for a file.
   *
   * JSON because a text option's rules have nothing in common with a date
   * option's, so columns would mean a table of mostly-NULLs growing one column
   * per type — the opposite of "adding a type touches three files".
   *
   * Validated by a versioned Zod schema at the API boundary. MySQL checks JSON
   * syntax, not shape.
   */
  @Column({ type: 'json', nullable: true })
  validation: Record<string, unknown> | null;

  /** Type-level pricing config. Per-value amounts live on `option_values`. */
  @Column({ type: 'json', nullable: true })
  pricing: Record<string, unknown> | null;

  /** Swatch size, column count, label placement, character counter. */
  @Column({ type: 'json', nullable: true })
  display: Record<string, unknown> | null;
}
