import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { StaffRole } from '../../common/database/enums';
import { User } from '../../users/entities/user.entity';

/**
 * Platform staff — our own team, not merchants.
 *
 * **A separate table, not a role value on `tenant_members`.** Realm separation
 * is structural: there is no row shape that expresses "merchant who is also
 * super_admin", so no bug can create one.
 *
 * Note that no staff role may edit merchant configuration. Staff diagnose and
 * advise; a genuine change goes through consented, audit-logged impersonation,
 * so the trail is honest about who did what.
 */
@Entity('platform_staff')
@Index('uq_platform_staff_user', ['userId'], { unique: true })
export class PlatformStaff extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 20 })
  role: StaffRole;

  /** `SET NULL`: the grant outlives whoever issued it. */
  @Column({ type: 'char', length: 36, nullable: true })
  grantedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'grantedBy' })
  granter: User | null;

  @Column({ type: 'datetime', precision: 3 })
  grantedAt: Date;

  /** Revocation is recorded rather than deleted, so the grant history survives. */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;
}
