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
export const LIVE_SENTINEL = new Date(1970, 0, 1, 0, 0, 0, 0);

/**
 * The sentinel as MySQL stores it, for use in a query parameter.
 *
 * ⚠️ **Do not pass `LIVE_SENTINEL` itself into a `WHERE`.** The driver converts a
 * JS `Date` into the connection's local time, so the comparison silently matches
 * nothing — verified: filtering five live rows by the `Date` returned zero, and
 * by this string returned five.
 *
 * The failure is silent in the worst direction. A scoping predicate that matches
 * nothing looks like an empty result set, not like a broken filter.
 */
export const LIVE_SENTINEL_SQL = '1970-01-01 00:00:00.000';

/**
 * Whether a value read from the database is the live sentinel.
 *
 * `LIVE_SENTINEL` is **local** midnight on 1970-01-01, not the UTC epoch, and
 * that is deliberate: the column holds the literal `1970-01-01 00:00:00.000`
 * with no zone of its own, and the driver converts on the way out. A UTC epoch
 * constant disagrees with the stored literal everywhere except UTC.
 *
 * Matches on the wall-clock components the literal encodes, so it is correct
 * whatever timezone the driver applied on the way out. An epoch comparison is
 * not, and was the defect this replaces.
 */
export function isSentinelDate(value: Date): boolean {
  return (
    value.getFullYear() === 1970 &&
    value.getMonth() === 0 &&
    value.getDate() === 1 &&
    value.getHours() === 0 &&
    value.getMinutes() === 0 &&
    value.getSeconds() === 0
  );
}

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

  /**
   * Whether this row is live.
   *
   * Compared by **wall-clock date**, not by instant.
   *
   * The sentinel is written as the literal `1970-01-01 00:00:00.000` — by the
   * migration default, by the seeds, and by any fixture — which bypasses the
   * driver's write-side conversion. Reading it back applies the read-side
   * conversion regardless, so on a UTC+6 machine the column arrives as
   * `1969-12-31T18:00:00Z` and an instant comparison says every live row is
   * deleted.
   *
   * Verified: `isLive` returned false for a row holding the correct sentinel.
   *
   * Comparing the wall-clock date is what the literal actually means — the
   * database column has no zone, and the value stored is the string, not an
   * instant. `getTime()` here would be asking a question the storage cannot
   * answer.
   */
  get isLive(): boolean {
    return isSentinelDate(this.deletedAt);
  }

  /** Mark the row deleted. Idempotent — re-deleting keeps the original time. */
  markDeleted(at: Date = new Date()): void {
    if (this.isLive) {
      this.deletedAt = at;
    }
  }

  /**
   * Restore a deleted row.
   *
   * Writes the sentinel as **local midnight on 1970-01-01**, because that is
   * what the driver converts into the literal `1970-01-01 00:00:00.000` the
   * migration default and the seeds write.
   *
   * Assigning `LIVE_SENTINEL` — the UTC epoch — writes a value offset by the
   * local timezone instead, so a restored row matched neither the literal nor
   * `isLive` and stayed invisible forever. Verified before this changed:
   * restoring wrote `1970-01-01 06:00:00`.
   */
  restore(): void {
    this.deletedAt = LIVE_SENTINEL;
  }
}
