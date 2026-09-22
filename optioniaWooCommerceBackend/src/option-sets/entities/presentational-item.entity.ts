import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { SoftDeletableEntity } from '../../common/database/base.entity';
import { PresentationalKind } from '../../common/database/enums';
import { OptionGroup } from './option-group.entity';

/**
 * A heading, paragraph, divider or rich-text block.
 *
 * **A separate table, not a row in `options`** (M5.4c). These have no value, no
 * validation, no pricing and produce no cart data. Modelling them as options
 * with `valueKind: none` would force null-checks through the renderer,
 * validator, pricing engine, cart integration and order persistence — five
 * subsystems paying for one convenience.
 *
 * M5.4c gives them exactly two systems: ordering, and conditional visibility.
 * ⚠️ **Only ordering exists.** `RuleTargetType` has no `item` member, so a rule
 * cannot point at one until Phase 17 adds it — the column and this entity are
 * ready, the targeting is not. The pricing engine never sees one either way.
 */
@Entity('presentational_items')
@Index('ix_presentational_group_order', ['optionGroupId', 'sortOrder'])
export class PresentationalItem extends SoftDeletableEntity {
  @Column({ type: 'char', length: 36 })
  optionGroupId: string;

  @ManyToOne(() => OptionGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'optionGroupId' })
  optionGroup: OptionGroup;

  @Column({ type: 'varchar', length: 20 })
  kind: PresentationalKind;

  /**
   * ⚠️ For `rich_text`, this is merchant-authored markup rendered on a **public
   * storefront** — an XSS vector by construction.
   *
   * Sanitised with a strict allowlist at publish *and* at render: no script, no
   * event-handler attributes, no iframe, no inline style with url(). Plan-gated,
   * because it is a support-and-liability surface rather than just a feature.
   */
  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'json', nullable: true })
  display: Record<string, unknown> | null;
}
