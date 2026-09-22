import { Column, Entity, Index } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';

/**
 * A person.
 *
 * Deliberately **not** tenant-scoped. The same person may belong to several
 * tenants — an agency managing multiple merchants is a real early segment — so
 * membership lives in `tenant_members` rather than as a column here.
 */
@Entity('users')
export class User extends BaseEntity {
  /**
   * Stored lowercase.
   *
   * Case-sensitive email is a duplicate-account bug: `Ana@shop.com` and
   * `ana@shop.com` are the same mailbox, and allowing both means one person with
   * two accounts and a support ticket nobody can resolve. Normalised on write
   * rather than compared case-insensitively, so the unique index does the work.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  /**
   * bcrypt hash, cost ≥ 12.
   *
   * Named `passwordHash` rather than `password` so no code path can mistake it
   * for a plaintext value — the column name is the last defence when someone
   * logs an entity.
   */
  @Column({ type: 'varchar', length: 255, select: false })
  passwordHash: string;

  /**
   * When the address was verified. Null means unverified.
   *
   * A timestamp rather than a boolean, because a separate `is_verified` flag can
   * disagree with the date and then nobody knows which is true.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** BCP-47 tag. Drives the language of transactional email. */
  @Column({ type: 'varchar', length: 10, default: 'en' })
  locale: string;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null;

  /**
   * Every access token issued before this instant is rejected.
   *
   * Access tokens are stateless and cannot be revoked individually — that is the
   * trade they exist to make. Without this, logging out left the token working
   * for the remainder of its lifetime: measured at **15 minutes**, and "I logged
   * out and it still worked" is a support ticket nobody can answer.
   *
   * A deny-list would close it too, at the cost of a database read on every
   * authenticated request. This costs nothing extra: `TenantGuard` already reads
   * the membership row per request, so the comparison rides on a query that
   * happens anyway.
   *
   * Removal and demotion are already immediate — `TenantGuard` reads the stored
   * role, so a token claiming `owner` resolves to whatever the row says. This
   * closes the two cases that were left: logout and password reset.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  sessionsInvalidatedAt: Date | null;
}
