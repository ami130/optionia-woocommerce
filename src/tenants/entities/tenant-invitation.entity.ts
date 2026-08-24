import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '../../common/database/base.entity';
import { TenantRole } from '../../common/database/enums';
import { Tenant } from './tenant.entity';
import { User } from '../../users/entities/user.entity';

/**
 * A pending invitation to join a tenant.
 *
 * Separate from `tenant_members` because the invitee may not have an account
 * yet — the invitation is addressed to an email, and only becomes a membership
 * when someone accepts it.
 */
@Entity('tenant_invitations')
@Index('ix_tenant_invitations_token', ['tokenHash'])
@Index('ix_tenant_invitations_pending', ['tenantId', 'email'])
export class TenantInvitation extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  /** Lowercased, matching `users.email`. */
  @Column({ type: 'varchar', length: 255 })
  email: string;

  /** Cannot exceed the inviter's own role — enforced in the service layer. */
  @Column({ type: 'varchar', length: 20 })
  role: TenantRole;

  /**
   * SHA-256 of the invitation token.
   *
   * **Hashed, not stored plaintext.** A readable invite token in the database is
   * a readable invite token in every backup and every support export of that
   * table — and it grants access to a tenant. The plaintext is emailed once and
   * never persisted.
   */
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Column({ type: 'char', length: 36, nullable: true })
  invitedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invitedBy' })
  inviter: User | null;

  /** Invitations expire. An indefinitely valid access grant is a liability. */
  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;
}
