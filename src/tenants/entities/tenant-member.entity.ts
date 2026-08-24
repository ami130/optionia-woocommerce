import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { TenantRole } from '../../common/database/enums';
import { Tenant } from './tenant.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Membership of a person in a tenant, with a role.
 *
 * A join table rather than `users.tenant_id`, because an agency managing several
 * merchant tenants is a real early segment and one person needs several
 * memberships.
 */
@Entity('tenant_members')
@Unique('uq_tenant_members_tenant_user', ['tenantId', 'userId'])
@Index('ix_tenant_members_user', ['userId'])
export class TenantMember extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  /** `CASCADE`: membership is meaningless without the tenant. */
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ type: 'char', length: 36 })
  userId: string;

  /** `CASCADE`: deleting a person removes their memberships, not the tenant. */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * See M6.5 for the capability matrix.
   *
   * The line that matters: `editor` may build option sets but not publish them.
   * Editing is safe; publishing changes a live storefront and what customers are
   * charged.
   */
  @Column({ type: 'varchar', length: 20 })
  role: TenantRole;

  /**
   * `SET NULL`: the membership outlives the person who created it.
   *
   * Deleting an admin must not cascade away the members they invited.
   */
  @Column({ type: 'char', length: 36, nullable: true })
  invitedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invitedBy' })
  inviter: User | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  invitedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;
}
