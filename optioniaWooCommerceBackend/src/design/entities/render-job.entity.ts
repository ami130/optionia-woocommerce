import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { Store } from '../../stores/entities/store.entity';

/**
 * One request to render a customer's design to a print file (M26e.4).
 *
 * 🔴 **A JOB, because Decision 2 chose asynchronous.** A synchronous render was
 * ruled out on measured numbers — 8 s, 20 s, 5 MB — and the customer has
 * already checked out by the time this matters. So the plugin asks, the cloud
 * answers "accepted", and the work happens where the fonts, the memory and the
 * CPU are.
 *
 * ⚠️ **This is NOT an order.** ADR-016 says an order is a historical fact the
 * cloud does not own, and `OrderSelection` carries no key to `options` or
 * `option_values` for that reason. A render job is the cloud's own record of
 * work it was asked to do, keyed by the line it belongs to rather than owning
 * it.
 *
 * 🔴 **It DOES key to the store, and the first draft did not — a schema test
 * caught it.** ADR-016 is about CONFIGURATION outliving an order, not about
 * tenancy: `order_events` and `option_view_counts` both carry a real
 * `storeId` foreign key, and every table must reach a tenant or be exempted
 * with a reason. A render job reaching no tenant would be artwork nobody owns.
 *
 * 📌 **The retry columns are `BillingEvent`'s, on purpose.** `attempts`,
 * `processedAt`, `deadAt` and `lastError` are the vocabulary F125's worker
 * already speaks, so the same claim pattern — `FOR UPDATE SKIP LOCKED`, the
 * attempt stamped before the work — applies without inventing a second one.
 */
@Entity('render_jobs')
/*
 * 🔴 **Idempotency lives in the INDEX, not in a check-then-insert.** The plugin
 * retries whenever a response is sent but never received, and WordPress cron is
 * not single-threaded — two passes can reach an insert at once. A `SELECT` then
 * `INSERT` looks like it handles that and does not; a unique key makes the race
 * impossible rather than unlikely, and M26e.4 requires exactly this: *"a retry
 * must not produce a second file"*.
 */
@Index('uq_render_jobs_line', ['storeId', 'lineRef'], { unique: true })
@Index('ix_render_jobs_pending', ['processedAt', 'deadAt', 'createdAt'])
@Index('ix_render_jobs_uncollected', ['collectBy'])
export class RenderJob extends BaseEntity {
  /** Which store asked. Resolved from the credential, never from the body. */
  @Column({ type: 'char', length: 36 })
  storeId: string;

  /**
   * 🔴 **`RESTRICT`, for the reason `order_events.store_id` is.** A job holds
   * the customer's own artwork and the file a merchant fulfils from;
   * disconnect-and-reconnect is the ordinary case — a migration, a staging
   * swap, a support fix — and `CASCADE` would silently erase the print files
   * for every order placed before it.
   */
  @ManyToOne(() => Store, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'storeId' })
  store: Store;

  /**
   * The cart line this render belongs to, as the STORE identifies it.
   *
   * 🔴 **Opaque to the cloud, and that is the point.** WooCommerce names a cart
   * line with its own hash; the cloud has no order table to join against and
   * ADR-016 says it should not. This is the handle the plugin will present when
   * it asks what became of its request.
   */
  @Column({ type: 'varchar', length: 128 })
  lineRef: string;

  /**
   * The resolved scene to rasterise.
   *
   * ⚠️ **Stored rather than re-derived.** A design the merchant edits tomorrow
   * must not change the file a customer bought today — the same reason
   * `OrderSelection` snapshots its labels. What is rendered is what was asked
   * for, not what the configuration later became.
   */
  @Column({ type: 'json' })
  scene: Record<string, unknown>;

  /** Pixel dimensions requested, checked against `checkRenderBounds` before any render. */
  @Column({ type: 'int' })
  width: number;

  @Column({ type: 'int' })
  height: number;

  /**
   * When the render finished. Null means pending or failed.
   *
   * 📌 **A fulfiller opening an order in the first seconds must see "the print
   * file is being prepared"** — Decision 2 calls that a milestone rather than a
   * detail, and this column is what lets the plugin say it.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  processedAt: Date | null;

  /**
   * Where the finished file went, as the plugin stored it.
   *
   * ⚠️ **Decision 3 put the bytes on the merchant's WordPress**, where every
   * other customer file already lives and where M15.6's quota already counts
   * them. The cloud records the location; it does not hold the file.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  fileUrl: string | null;

  /**
   * 🔴 **Incremented BEFORE the work, so a process that dies mid-render still
   * burns an attempt.** Incrementing on completion would let a crash-looping
   * job retry for ever without ever reaching the dead-letter.
   */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /**
   * When the job was given up on.
   *
   * 🔴 **A dead row is never retried again**, and is not the same as a
   * processed one: M26e.6 requires the source design be retained so a merchant
   * can ask for it to be re-rendered.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  deadAt: Date | null;

  /** Why the last attempt failed, for the dashboard and for support. */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /**
   * The rendered PNG, waiting to be collected (Decision 3b).
   *
   * 🔴 **A BUFFER, not a home.** Decision 3 put the print file on the
   * merchant's WordPress; this is where the bytes wait while the plugin comes
   * for them. It is null before the render and null again afterwards — the
   * bytes exist only in between.
   *
   * ⚠️ **In the database because Decision 1's disk is ephemeral by design.** A
   * buffer on local disk loses its bytes on every deploy, and the worker claims
   * `processedAt IS NULL`, so a job whose buffer vanished would never be
   * re-claimed: stuck at `rendered` for ever.
   *
   * 📌 **Measured: 0.40 MB at the 36-megapixel ceiling**, against a 16 MB
   * column and a 64 MB packet limit.
   */
  @Column({ type: 'mediumblob', nullable: true })
  png: Buffer | null;

  /**
   * When an uncollected buffer becomes a problem rather than a wait.
   *
   * 🔴 **Decision 3a names the drift this exists to catch**: *"if collection
   * ever fails silently, the buffer becomes the home by accident."* A row past
   * this date with `png` still set is that symptom — queryable, rather than
   * inferred from two nulls.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  collectBy: Date | null;
}
