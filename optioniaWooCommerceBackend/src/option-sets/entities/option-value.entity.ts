import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { PriceType } from '../../common/database/enums';
import { moneyTransformer } from '../../common/money/money.transformer';
import { Option } from './option.entity';

/**
 * One selectable value within a choice option.
 *
 * `priceType` and `priceAmountMinor` are **real columns, not JSON** (ADR-015).
 * Analytics and plan limits both filter on them, and a JSON blob would make
 * "which values cost more than $50" a full scan with JSON extraction.
 */
@Entity('option_values')
@Unique('uq_option_values_option_key', ['optionId', 'valueKey', 'deletedAt'])
@Index('ix_option_values_option_order', ['optionId', 'sortOrder'])
export class OptionValue extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionId: string;

  @ManyToOne(() => Option, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionId' })
  option: Option;

  /** Stored in order meta alongside `option.key`. Immutable after publish. */
  @Column({ type: 'varchar', length: 64 })
  valueKey: string;

  @Column({ type: 'varchar', length: 200 })
  label: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'varchar', length: 20, default: PriceType.FIXED })
  priceType: PriceType;

  /**
   * Integer minor units — cents, yen, fils (ADR-013).
   *
   * May be negative: an option that reduces the price is legitimate, floored at
   * zero when the line total is computed.
   */
  @Column({ type: 'bigint', default: 0, transformer: moneyTransformer })
  priceAmountMinor: number;

  /** Tier brackets and other shape-varying pricing detail. */
  @Column({ type: 'json', nullable: true })
  priceConfig: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  @Column({ type: 'char', length: 7, nullable: true })
  colorHex: string | null;

  /**
   * The `<optgroup>` this value belongs to, by label (M14.3).
   *
   * ⚠️ **A label, not a foreign key.** Groups here are a presentation device with
   * no identity of their own — they have no ordering, no rules and no pricing, so
   * a `value_groups` table would add a join and a lifecycle to carry one string.
   * Values sharing a label render under one heading; that is the whole model.
   *
   * `null` means "not grouped" and renders as a plain `<option>`. It is not the
   * same as `''`, which would put the value in a nameless group.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  groupLabel: string | null;

  /** Appended to the line SKU. Fulfilment systems match on SKU. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  skuSuffix: string | null;

  /**
   * Shipping weight this value adds.
   *
   * Price is not the only consequence of a selection: "heavy oak" changes what
   * is shipped, and weight-based shipping rates are wrong without it (M16.8).
   */
  @Column({ type: 'int', nullable: true })
  weightDeltaGrams: number | null;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  /**
   * Whether this value appears in the published config.
   *
   * **A soft toggle, and deliberately not soft delete.** M7.2 lists them as
   * separate operations because they mean different things: deleting hides
   * something permanently and is a cleanup action, disabling is reversible and is
   * expected to be undone. `deleted_at` cannot express "turn this off for the
   * holidays without losing the work".
   *
   * Disabled rows are retained in full — their pricing and media survive, so re-enabling
   * restores exactly what was there rather than an empty shell.
   *
   * Defaults to enabled: something a merchant just created is something they want
   * live, and requiring an extra click to publish new work would be surprising.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;
}
