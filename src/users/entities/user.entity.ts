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
}
