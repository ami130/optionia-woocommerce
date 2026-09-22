import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A record of staff acting as a merchant.
 *
 * `RESTRICT` on both sides, deliberately: this is the audit trail for the most
 * sensitive action the platform permits, and it must not be removable by
 * deleting either party. Never soft-deleted, never purged.
 */
@Entity('impersonation_sessions')
@Index('ix_impersonation_tenant', ['tenantId', 'startedAt'])
export class ImpersonationSession extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  staffUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'staffUserId' })
  staffUser: User;

  @Column({ type: 'char', length: 36 })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /**
   * When the merchant consented.
   *
   * Required, not nullable: a session without recorded consent should be
   * impossible to create, and the column type is what makes that true.
   */
  @Column({ type: 'datetime', precision: 3 })
  consentedAt: Date;

  @Column({ type: 'datetime', precision: 3 })
  startedAt: Date;

  /** Time-boxed. An open-ended impersonation session is a standing credential. */
  @Column({ type: 'datetime', precision: 3 })
  endsAt: Date;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  endedAt: Date | null;

  @Column({ type: 'varchar', length: 500 })
  reason: string;
}
