import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Tenant } from '../../tenants/entities/tenant.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Who did what, to which resource, when.
 *
 * Both foreign keys are `SET NULL` rather than `RESTRICT`, and that is the
 * consequential choice here.
 *
 * Under `RESTRICT`, deleting a user would be **impossible** while any audit
 * entry referenced them — and Phase 26b requires erasing a user on request. The
 * log must record that an action happened even after the actor is gone; the
 * action, resource and diff carry the meaning, and the identity is precisely the
 * part being erased.
 */
@Entity('audit_logs')
@Index('ix_audit_tenant_time', ['tenantId', 'createdAt'])
@Index('ix_audit_resource', ['resourceType', 'resourceId'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', length: 36, nullable: true })
  tenantId: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant | null;

  @Column({ type: 'char', length: 36, nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  /** e.g. `option_set.published`, `member.role_changed`. */
  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ type: 'varchar', length: 40 })
  resourceType: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  resourceId: string | null;

  /** Before and after. What actually changed, not merely that something did. */
  @Column({ type: 'json', nullable: true })
  changes: Record<string, unknown> | null;

  /**
   * `VARBINARY(16)` holds IPv4 and IPv6 in one column.
   *
   * ⚠️ An IP address is personal data under GDPR, so this column is subject to
   * the retention policy in Phase 26b rather than kept indefinitely.
   */
  @Column({ type: 'varbinary', length: 16, nullable: true })
  ip: Buffer | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt: Date;
}
