import { BeforeInsert, Column, CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

/**
 * The sentinel written to `deleted_at` on a live row.
 *
 * A live row is `deleted_at = LIVE_SENTINEL`, **never** `deleted_at IS NULL`.
 *
 * The reason is a MySQL behaviour that makes the obvious design useless: in a
 * unique index `NULL != NULL`, so `UNIQUE (key, deleted_at)` with a nullable
 * column permits unlimited live duplicates. Verified against MySQL 9.6 — two
 * rows with the same key and `deleted_at = NULL` both insert successfully.
 *
 * See ADR-014 for the test and the two rejected alternatives.
 */
export const LIVE_SENTINEL = new Date('1970-01-01T00:00:00.000Z');

/**
 * Identity and timestamps for every tenant-scoped entity.
 *
 * The primary key is UUIDv7, generated in the application rather than by the
 * database.
 *
 * TypeORM's `@PrimaryGeneratedColumn('uuid')` emits **v4**, which is random and
 * therefore fragments the primary-key index on every insert. v7 embeds a
 * millisecond timestamp in its leading bits, so rows insert in roughly
 * chronological order and `ORDER BY id` stays meaningful without a separate
 * index. See ADR-004.
 */
export abstract class BaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id: string;

  /**
   * Precision is declared on both the column and its default.
   *
   * TypeORM emits `CURRENT_TIMESTAMP(6)` regardless of the column's precision,
   * and MySQL rejects a `datetime(3)` column defaulting to a 6-digit timestamp
   * with `Invalid default value`. Stating it explicitly keeps the two in step.
   */
  @CreateDateColumn({ type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  /**
   * Assign the id before insert.
   *
   * Generated here rather than by MySQL so the id is known before the row
   * exists — which is what lets a service build a graph of related entities in
   * memory and persist them in one transaction.
   */
  @BeforeInsert()
  protected assignId(): void {
    if (!this.id) {
      this.id = uuidv7();
    }
  }
}

/**
 * Base for merchant-authored content, which is soft-deleted.
 *
 * ⚠️ **`@DeleteDateColumn` is deliberately not used.** TypeORM's built-in
 * soft-delete writes NULL to mark a row live, which is exactly the design that
 * fails above. The column here is `NOT NULL` with the sentinel as its default,
 * and deletion is performed through `SoftDeletable.markDeleted()` rather than
 * `repository.softDelete()`.
 *
 * Applies only to configuration — option sets, groups, options, values, rules,
 * assignments. Never to anything a customer typed: an engraving message carries
 * personal data and must be *erased*, not flagged. See ADR-014.
 */
export abstract class SoftDeletableEntity extends BaseEntity {
  @Column({
    type: 'datetime',
    precision: 3,
    nullable: false,
    default: () => "'1970-01-01 00:00:00.000'",
  })
  deletedAt: Date;

  /** Whether this row is live. */
  get isLive(): boolean {
    return this.deletedAt.getTime() === LIVE_SENTINEL.getTime();
  }

  /** Mark the row deleted. Idempotent — re-deleting keeps the original time. */
  markDeleted(at: Date = new Date()): void {
    if (this.isLive) {
      this.deletedAt = at;
    }
  }

  /** Restore a deleted row. */
  restore(): void {
    this.deletedAt = LIVE_SENTINEL;
  }
}
