import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * How many customers saw one option, on one store, on one day (M25.1).
 *
 * 🔴 **A count, never an event.** A view is every product page load; storing one
 * row each would make this the busiest table in the system, driven by a
 * merchant's traffic rather than their sales. The plugin aggregates before
 * sending, so a day's looking is one row per option.
 *
 * 🔒 **There is nothing here about a person**, and that is deliberate rather
 * than incidental. No customer, no session, no address, no time of day — one
 * visit is indistinguishable from another inside a day, which keeps views
 * outside personal data entirely and out of M25.6's retention question.
 *
 * ⚠️ **`optionSetId` and `optionKey` carry no foreign key**, following ADR-016
 * as `order_selections` does: a view is a historical fact and must not vanish
 * because a merchant later deleted the option.
 *
 * 🔴 **`storeId` is `ON DELETE RESTRICT`, and the first draft had it CASCADE.**
 * Writing the documentation is what caught it: `order_events.store_id` is
 * RESTRICT because *"disconnecting a store must not silently take its revenue
 * history with it"*, and views are not revenue — they are the **denominator of
 * a conversion rate**. Losing them is worse than losing a number, because every
 * comparison drawn afterwards is silently wrong rather than visibly absent: a
 * reconnected store would show orders with no views, and conversion would read
 * as infinite on a shop that plainly has traffic.
 */
@Entity('option_view_counts')
@Index('uq_option_view_counts', ['storeId', 'optionSetId', 'optionKey', 'day'], { unique: true })
@Index('ix_option_view_counts_day', ['storeId', 'day'])
export class OptionViewCount {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  @Column({ type: 'char', length: 36 })
  storeId: string;

  @Column({ type: 'char', length: 36 })
  optionSetId: string;

  @Column({ type: 'varchar', length: 64 })
  optionKey: string;

  /**
   * The STORE's day, not UTC's.
   *
   * ⚠️ A shop in Auckland splits its evening across two UTC dates, so a
   * merchant comparing today against yesterday would compare the wrong halves.
   * The plugin computes this locally and sends it.
   */
  @Column({ type: 'date' })
  day: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  views: number;

  @Column({ type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;

  @Column({
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;
}
