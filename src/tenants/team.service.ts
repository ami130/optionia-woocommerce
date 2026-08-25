import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { expiresIn, generateToken, hashToken, hasExpired } from '../common/crypto/tokens';
import { TenantRole } from '../common/database/enums';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TenantInvitation } from './entities/tenant-invitation.entity';
import { TenantMember } from './entities/tenant-member.entity';

/**
 * Team membership: invite, accept, change role, remove.
 *
 * Two rules here are security controls rather than validation, and both are
 * enforced in this service rather than at the edge — a check that lives only in a
 * controller is one a background job or a future endpoint can walk past.
 */

/** Invitations last a week. Long enough for a holiday, short enough to expire. */
export const INVITATION_TTL_MINUTES = 7 * 24 * 60;

/** One message for every way the last-owner guard refuses. */
const LAST_OWNER_MESSAGE =
  'This workspace must keep at least one owner. Make someone else an owner first.';

@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TenantMember)
    private readonly members: Repository<TenantMember>,
    @InjectRepository(TenantInvitation)
    private readonly invitations: Repository<TenantInvitation>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Invite someone to a tenant.
   *
   * **An inviter cannot grant a role above their own.** Without this an `admin`
   * invites a stranger as `owner`, that stranger promotes the admin, and the
   * privilege ceiling the matrix describes is decorative. The check is here, not
   * in the controller, because it is the rule rather than a UI courtesy.
   *
   * @returns The plaintext token, to be emailed. Never stored.
   */
  async invite(
    tenantId: string,
    inviterUserId: string,
    inviterRole: string,
    email: string,
    role: TenantRole,
  ): Promise<string> {
    this.assertCanGrant(inviterRole, role);

    const address = email.trim().toLowerCase();

    const existing = await this.members
      .createQueryBuilder('m')
      .innerJoin('users', 'u', 'u.id = m.userId')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('u.email = :address', { address })
      .andWhere('m.revokedAt IS NULL')
      .getOne();

    if (existing) {
      throw DomainException.conflict('That person is already a member of this workspace.');
    }

    // Supersede any outstanding invitation for the same address, so a resend
    // does not leave two live links with possibly different roles.
    await this.invitations.update(
      { tenantId, email: address, acceptedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    const token = generateToken();

    await this.invitations.save(
      this.invitations.create({
        tenantId,
        email: address,
        role,
        tokenHash: token.hash,
        invitedBy: inviterUserId,
        expiresAt: expiresIn(INVITATION_TTL_MINUTES),
      }),
    );

    await this.audit.record({
      action: AuditAction.MEMBER_INVITED,
      resourceType: 'tenant_invitation',
      changes: { email: address, role },
      tenantId,
      userId: inviterUserId,
    });

    return token.plaintext;
  }

  /**
   * Accept an invitation.
   *
   * The membership and the invitation's consumption are one transaction: a
   * consumed invitation with no membership is a person who cannot get in and
   * cannot retry.
   */
  async accept(plaintext: string, userId: string, userEmail: string): Promise<TenantMember> {
    const invitation = await this.invitations.findOne({
      where: { tokenHash: hashToken(plaintext) },
    });

    if (
      invitation === null ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      hasExpired(invitation.expiresAt)
    ) {
      // One answer for every failure. Distinguishing "expired" from "never
      // existed" confirms an invitation was once real, and these arrive by email
      // where a link can be forwarded or guessed at.
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That invitation is no longer valid. Ask for a new one.',
      );
    }

    // The invitation names an address. Accepting it while signed in as someone
    // else would transfer the grant to whoever clicked the link.
    if (invitation.email !== userEmail.trim().toLowerCase()) {
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'This invitation was sent to a different email address.',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.update(TenantInvitation, { id: invitation.id }, { acceptedAt: new Date() });

      const revoked = await manager.findOne(TenantMember, {
        where: { tenantId: invitation.tenantId, userId },
      });

      // Re-inviting someone previously removed reuses their row, so the tenant
      // does not accumulate a second membership for the same person.
      if (revoked) {
        await manager.update(
          TenantMember,
          { id: revoked.id },
          { role: invitation.role, revokedAt: null, acceptedAt: new Date() },
        );

        return manager.findOneOrFail(TenantMember, { where: { id: revoked.id } });
      }

      return manager.save(
        manager.create(TenantMember, {
          tenantId: invitation.tenantId,
          userId,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          invitedAt: invitation.createdAt,
          acceptedAt: new Date(),
        }),
      );
    });
  }

  /**
   * Change a member's role.
   *
   * Only `owner` reaches this (the matrix enforces that), so the remaining rule
   * is the one the matrix cannot express: the last owner may not be demoted.
   */
  async changeRole(tenantId: string, memberId: string, role: TenantRole): Promise<void> {
    const member = await this.requireMember(tenantId, memberId);

    if (member.role === TenantRole.OWNER && role !== TenantRole.OWNER) {
      await this.demoteLastOwnerSafely(tenantId, member.id, role);
    } else {
      await this.members.update({ id: member.id }, { role });
    }

    // Recorded after the change, so a failed update leaves no entry claiming it
    // happened. Before/after is the whole value: "who made this person an owner"
    // is the question asked after an incident.
    await this.audit.record({
      action: AuditAction.MEMBER_ROLE_CHANGED,
      resourceType: 'tenant_member',
      resourceId: member.id,
      changes: { role: { from: member.role, to: role } },
      tenantId,
    });
  }

  /**
   * Remove a member.
   *
   * Revoked rather than deleted: the row is what makes "who did this, and were
   * they a member at the time" answerable after the fact.
   */
  async remove(tenantId: string, memberId: string): Promise<void> {
    const member = await this.requireMember(tenantId, memberId);

    if (member.role === TenantRole.OWNER) {
      await this.removeOwnerSafely(tenantId, member.id);
    } else {
      await this.members.update({ id: member.id }, { revokedAt: new Date() });
    }

    await this.audit.record({
      action: AuditAction.MEMBER_REMOVED,
      resourceType: 'tenant_member',
      resourceId: member.id,
      changes: { userId: member.userId, role: member.role },
      tenantId,
    });
  }

  /** Cancel an outstanding invitation. */
  async revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
    await this.invitations.update(
      { id: invitationId, tenantId, acceptedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /** Outstanding invitations, for the pending-invites list. */
  async pendingInvitations(tenantId: string): Promise<TenantInvitation[]> {
    return this.invitations.find({
      where: { tenantId, acceptedAt: IsNull(), revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** Live members of a tenant. */
  async listMembers(tenantId: string): Promise<TenantMember[]> {
    return this.members.find({
      where: { tenantId, revokedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * A tenant must always have at least one owner.
   *
   * Otherwise a tenant becomes unadministrable: nobody can change roles, alter
   * billing, or delete it, and the only fix is a support request that edits the
   * database by hand.
   */
  /**
   * Demote an owner, refusing if they are the last.
   *
   * **The count is inside the write.** Counting first and updating after is a
   * race: two owners demoted at the same instant both count two, both proceed,
   * and the tenant is left with none — unadministrable, repairable only by
   * editing the database. Confirmed by probe before this was written.
   *
   * The subquery re-counts under the same row locks the UPDATE takes, so the
   * second statement sees the first one's effect.
   */
  private async demoteLastOwnerSafely(
    tenantId: string,
    memberId: string,
    role: TenantRole,
  ): Promise<void> {
    await this.runOwnerStatement(
      `UPDATE tenant_members SET role = ?, updatedAt = NOW(3)
        WHERE id = ? AND tenantId = ? AND role = 'owner' AND revokedAt IS NULL
          AND (
            SELECT owners FROM (
              SELECT COUNT(*) AS owners FROM tenant_members
               WHERE tenantId = ? AND role = 'owner' AND revokedAt IS NULL
            ) AS counted
          ) > 1`,
      [role, memberId, tenantId, tenantId],
    );
  }

  /** Remove an owner, refusing if they are the last. Same reasoning as above. */
  private async removeOwnerSafely(tenantId: string, memberId: string): Promise<void> {
    await this.runOwnerStatement(
      `UPDATE tenant_members SET revokedAt = NOW(3), updatedAt = NOW(3)
        WHERE id = ? AND tenantId = ? AND role = 'owner' AND revokedAt IS NULL
          AND (
            SELECT owners FROM (
              SELECT COUNT(*) AS owners FROM tenant_members
               WHERE tenantId = ? AND role = 'owner' AND revokedAt IS NULL
            ) AS counted
          ) > 1`,
      [memberId, tenantId, tenantId],
    );
  }

  /**
   * `affectedRows === 0` means the guard in the statement refused it.
   *
   * The member was verified to exist moments earlier, so the only condition that
   * can have failed is the owner count — which is exactly the refusal to report.
   */
  private assertChanged(result: { affectedRows?: number }): void {
    if ((result.affectedRows ?? 0) === 0) {
      throw DomainException.conflict(LAST_OWNER_MESSAGE);
    }
  }

  /**
   * Run a guarded owner statement, turning a deadlock into the same refusal.
   *
   * Two owners removed simultaneously take row locks in opposite orders, and
   * MySQL resolves that by aborting one — correctly, and with a raw
   * `ER_LOCK_DEADLOCK` that means nothing to a caller.
   *
   * The aborted statement is the one that would have left no owner, so the
   * honest translation is the refusal rather than a retry: retrying would only
   * re-attempt an operation the guard exists to reject.
   */
  private async runOwnerStatement(sql: string, params: unknown[]): Promise<void> {
    try {
      this.assertChanged(await this.members.query(sql, params));
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_LOCK_DEADLOCK') {
        throw DomainException.conflict(LAST_OWNER_MESSAGE);
      }

      throw error;
    }
  }

  private async requireMember(tenantId: string, memberId: string): Promise<TenantMember> {
    const member = await this.members.findOne({
      where: { id: memberId, tenantId, revokedAt: IsNull() },
    });

    if (member === null) {
      // Scoped to the tenant, so a member id from another workspace is "not
      // found" rather than "forbidden" (ADR-010).
      throw DomainException.notFound('Member');
    }

    return member;
  }

  /**
   * An inviter may not grant a role above their own.
   *
   * Expressed as an explicit pair rather than a rank comparison, because the
   * roles are not ranked: `billing` and `editor` are incomparable, and any
   * ordering would be inventing a hierarchy the matrix deliberately avoids.
   */
  private assertCanGrant(inviterRole: string, granted: TenantRole): void {
    const grantable: Record<string, readonly TenantRole[]> = {
      [TenantRole.OWNER]: [
        TenantRole.OWNER,
        TenantRole.ADMIN,
        TenantRole.EDITOR,
        TenantRole.VIEWER,
        TenantRole.BILLING,
      ],
      // Notably not `owner`: an admin who could invite an owner could have that
      // owner promote them, which is the privilege ceiling defeating itself.
      [TenantRole.ADMIN]: [
        TenantRole.ADMIN,
        TenantRole.EDITOR,
        TenantRole.VIEWER,
        TenantRole.BILLING,
      ],
    };

    if (!grantable[inviterRole]?.includes(granted)) {
      throw new DomainException(
        ErrorCode.INSUFFICIENT_ROLE,
        'You cannot grant a role above your own.',
      );
    }
  }
}
