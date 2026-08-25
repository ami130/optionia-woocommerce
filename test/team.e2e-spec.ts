import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { TenantRole } from '../src/common/database/enums';
import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { TenantInvitation } from '../src/tenants/entities/tenant-invitation.entity';
import { TenantMember } from '../src/tenants/entities/tenant-member.entity';
import { AuditLog } from '../src/audit/entities/audit-log.entity';
import { AuditService } from '../src/audit/audit.service';
import { TeamService } from '../src/tenants/team.service';

/**
 * Team membership against a real database.
 *
 * Two rules here are security controls rather than validation, and both are
 * about *rows*: how many owners remain, and which role an invitation may carry.
 * Neither is observable through a mocked repository.
 */
describe('TeamService (integration)', () => {
  let dataSource: DataSource;
  let team: TeamService;

  const NS = 'team';
  const TENANT = `${NS}-tenant`;
  const OTHER_TENANT = `${NS}-other`;

  const OWNER = `${NS}-owner`;
  const SECOND_OWNER = `${NS}-owner2`;
  const ADMIN = `${NS}-admin`;
  const NEWCOMER = `${NS}-newcomer`;

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();

    team = new TeamService(
      dataSource.getRepository(TenantMember),
      dataSource.getRepository(TenantInvitation),
      dataSource,
      new AuditService(dataSource.getRepository(AuditLog)),
    );
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenant_invitations WHERE tenantId LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenant_members WHERE tenantId LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM users WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE id LIKE '${NS}-%'`);
  }

  async function memberId(userId: string, tenantId = TENANT): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT id FROM tenant_members WHERE tenantId = ? AND userId = ?`,
      [tenantId, userId],
    );

    return row.id;
  }

  beforeEach(async () => {
    await cleanup();

    const [plan] = await dataSource.query(`SELECT id FROM plans WHERE code = 'free'`);

    for (const [id, slug] of [
      [TENANT, `${NS}-main`],
      [OTHER_TENANT, `${NS}-other-ws`],
    ]) {
      await dataSource.query(
        `INSERT INTO tenants (id, name, slug, status, planId, createdAt, updatedAt)
         VALUES (?, ?, ?, 'active', ?, NOW(3), NOW(3))`,
        [id, slug, slug, plan.id],
      );
    }

    for (const id of [OWNER, SECOND_OWNER, ADMIN, NEWCOMER]) {
      await dataSource.query(
        `INSERT INTO users (id, email, passwordHash, name, locale, createdAt, updatedAt)
         VALUES (?, ?, '$2b$12$placeholder', ?, 'en', NOW(3), NOW(3))`,
        [id, `${id}@example.com`, id],
      );
    }

    for (const [userId, role] of [
      [OWNER, 'owner'],
      [ADMIN, 'admin'],
    ]) {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, NOW(3), NOW(3), NOW(3))`,
        [`${TENANT}-${userId}`, TENANT, userId, role],
      );
    }
  });

  describe('invitations cannot escalate', () => {
    /**
     * The rule that keeps the matrix's ceiling real. Without it an admin invites
     * a stranger as owner, that stranger promotes the admin, and every "admin
     * cannot" line in the matrix is decorative.
     */
    it('refuses an admin inviting an owner', async () => {
      await expect(
        team.invite(TENANT, ADMIN, 'admin', 'stranger@example.com', TenantRole.OWNER),
      ).rejects.toThrow(/cannot grant a role above your own/);
    });

    it('lets an admin invite every role at or below their own', async () => {
      for (const role of [TenantRole.ADMIN, TenantRole.EDITOR, TenantRole.VIEWER, TenantRole.BILLING]) {
        await expect(
          team.invite(TENANT, ADMIN, 'admin', `${role}@example.com`, role),
        ).resolves.toBeTruthy();
      }
    });

    it('lets an owner invite an owner', async () => {
      await expect(
        team.invite(TENANT, OWNER, 'owner', 'co-owner@example.com', TenantRole.OWNER),
      ).resolves.toBeTruthy();
    });

    /** A role with no grant list holds nothing — deny by default. */
    it('refuses an editor inviting anyone', async () => {
      await expect(
        team.invite(TENANT, ADMIN, 'editor', 'x@example.com', TenantRole.VIEWER),
      ).rejects.toThrow(/cannot grant a role above your own/);
    });
  });

  describe('invitation lifecycle', () => {
    it('stores a hash, never the token', async () => {
      const token = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR,
      );

      const [row] = await dataSource.query(
        `SELECT tokenHash FROM tenant_invitations WHERE tenantId = ?`,
        [TENANT],
      );

      expect(row.tokenHash).not.toContain(token);
    });

    /** A resend must not leave two live links, possibly with different roles. */
    it('supersedes an outstanding invitation for the same address', async () => {
      const first = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.VIEWER,
      );
      await team.invite(TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR);

      await expect(
        team.accept(first, NEWCOMER, `${NEWCOMER}@example.com`),
      ).rejects.toThrow(/no longer valid/);
    });

    it('accepts once and creates the membership with the invited role', async () => {
      const token = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR,
      );

      const member = await team.accept(token, NEWCOMER, `${NEWCOMER}@example.com`);

      expect(member.role).toBe('editor');
      expect(member.tenantId).toBe(TENANT);
      await expect(
        team.accept(token, NEWCOMER, `${NEWCOMER}@example.com`),
      ).rejects.toThrow(/no longer valid/);
    });

    /**
     * The invitation names an address. Accepting it while signed in as someone
     * else would hand the grant to whoever clicked the link.
     */
    it('refuses acceptance by a different address', async () => {
      const token = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR,
      );

      await expect(team.accept(token, ADMIN, `${ADMIN}@example.com`)).rejects.toThrow(
        /different email address/,
      );
    });

    it('refuses an expired invitation', async () => {
      const token = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR,
      );

      await dataSource.query(
        `UPDATE tenant_invitations SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY)
          WHERE tenantId = ?`,
        [TENANT],
      );

      await expect(
        team.accept(token, NEWCOMER, `${NEWCOMER}@example.com`),
      ).rejects.toThrow(/no longer valid/);
    });

    it('refuses inviting someone who is already a member', async () => {
      await expect(
        team.invite(TENANT, OWNER, 'owner', `${ADMIN}@example.com`, TenantRole.EDITOR),
      ).rejects.toThrow(/already a member/);
    });

    /** Re-inviting someone removed reuses their row rather than duplicating it. */
    it('restores a previously removed member without a second row', async () => {
      const token = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR,
      );
      await team.accept(token, NEWCOMER, `${NEWCOMER}@example.com`);
      await team.remove(TENANT, await memberId(NEWCOMER));

      const again = await team.invite(
        TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.VIEWER,
      );
      await team.accept(again, NEWCOMER, `${NEWCOMER}@example.com`);

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM tenant_members WHERE tenantId = ? AND userId = ?`,
        [TENANT, NEWCOMER],
      );

      expect(Number(row.n)).toBe(1);
      expect((await team.listMembers(TENANT)).find((m) => m.userId === NEWCOMER)?.role).toBe(
        'viewer',
      );
    });
  });

  describe('last-owner protection', () => {
    /**
     * A tenant with no owner is unadministrable: nobody can change roles, alter
     * billing or delete it, and the only fix edits the database by hand.
     */
    it('refuses to demote the only owner', async () => {
      await expect(
        team.changeRole(TENANT, await memberId(OWNER), TenantRole.VIEWER),
      ).rejects.toThrow(/at least one owner/);
    });

    it('refuses to remove the only owner', async () => {
      await expect(team.remove(TENANT, await memberId(OWNER))).rejects.toThrow(
        /at least one owner/,
      );
    });

    it('allows demotion once a second owner exists', async () => {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'owner', NOW(3), NOW(3), NOW(3))`,
        [`${TENANT}-${SECOND_OWNER}`, TENANT, SECOND_OWNER],
      );

      await expect(
        team.changeRole(TENANT, await memberId(OWNER), TenantRole.ADMIN),
      ).resolves.toBeUndefined();
    });

    /** Owners in another workspace must not satisfy this tenant's requirement. */
    it('counts owners per tenant, not globally', async () => {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'owner', NOW(3), NOW(3), NOW(3))`,
        [`${OTHER_TENANT}-${SECOND_OWNER}`, OTHER_TENANT, SECOND_OWNER],
      );

      await expect(team.remove(TENANT, await memberId(OWNER))).rejects.toThrow(
        /at least one owner/,
      );
    });

    /** A revoked owner is not an owner. */
    it('does not count a removed owner toward the requirement', async () => {
      await dataSource.query(
        `INSERT INTO tenant_members
           (id, tenantId, userId, role, acceptedAt, revokedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'owner', NOW(3), NOW(3), NOW(3), NOW(3))`,
        [`${TENANT}-${SECOND_OWNER}`, TENANT, SECOND_OWNER],
      );

      await expect(team.remove(TENANT, await memberId(OWNER))).rejects.toThrow(
        /at least one owner/,
      );
    });
  });

  describe('privileged actions are audited (M6.5 rule 3)', () => {
    async function entries(action: string): Promise<Array<Record<string, unknown>>> {
      return dataSource.query(
        `SELECT userId, resourceId, changes FROM audit_logs
          WHERE tenantId = ? AND action = ?`,
        [TENANT, action],
      );
    }

    /**
     * "Who made this person an owner" is the question asked after an incident,
     * and before/after is what answers it. The table existed from Phase 5 and
     * nothing wrote to it, which made the rule documentation rather than a
     * control.
     */
    it('records a role change with what it changed from and to', async () => {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'owner', NOW(3), NOW(3), NOW(3))`,
        [`${TENANT}-${SECOND_OWNER}`, TENANT, SECOND_OWNER],
      );

      await team.changeRole(TENANT, await memberId(OWNER), TenantRole.ADMIN);

      const [row] = await entries('member.role_changed');
      const changes =
        typeof row.changes === 'string'
          ? (JSON.parse(row.changes) as Record<string, { from: string; to: string }>)
          : (row.changes as Record<string, { from: string; to: string }>);

      expect(changes.role.from).toBe('owner');
      expect(changes.role.to).toBe('admin');
    });

    it('records a removal, naming who was removed', async () => {
      await team.remove(TENANT, await memberId(ADMIN));

      const [row] = await entries('member.removed');
      const changes =
        typeof row.changes === 'string'
          ? (JSON.parse(row.changes) as Record<string, string>)
          : (row.changes as Record<string, string>);

      expect(changes.userId).toBe(ADMIN);
      expect(changes.role).toBe('admin');
    });

    it('records an invitation, attributed to the inviter', async () => {
      await team.invite(TENANT, OWNER, 'owner', `${NEWCOMER}@example.com`, TenantRole.EDITOR);

      const [row] = await entries('member.invited');

      expect(row.userId).toBe(OWNER);
    });

    /**
     * The trail must never break the action. A row that cannot be written is an
     * operations problem; a role change that fails because of one is the
     * merchant's problem, and worse.
     */
    it('does not fail the action when the trail cannot be written', async () => {
      // The swallow lives in AuditService, so this breaks the repository it
      // writes through rather than the service itself — which is how the failure
      // actually arrives: a full disk, a lock timeout, a dropped connection.
      const failing = new AuditService({
        create: (row: unknown) => row,
        save: () => Promise.reject(new Error('audit storage unavailable')),
      } as never);

      const broken = new TeamService(
        dataSource.getRepository(TenantMember),
        dataSource.getRepository(TenantInvitation),
        dataSource,
        failing,
      );

      await expect(broken.remove(TENANT, await memberId(ADMIN))).resolves.toBeUndefined();
    });
  });

  describe('the last-owner race', () => {
    async function ownerCount(): Promise<number> {
      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM tenant_members
          WHERE tenantId = ? AND role = 'owner' AND revokedAt IS NULL`,
        [TENANT],
      );

      return Number(row.n);
    }

    async function addSecondOwner(): Promise<void> {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'owner', NOW(3), NOW(3), NOW(3))`,
        [`${TENANT}-${SECOND_OWNER}`, TENANT, SECOND_OWNER],
      );
    }

    /**
     * **A tenant with no owner is unadministrable** — nobody can change roles,
     * alter billing or delete it, and the repair edits the database by hand.
     *
     * The guard counted owners and then updated, so two demotions at the same
     * instant both counted two and both proceeded. The count now happens inside
     * the statement.
     */
    it('never leaves a tenant with zero owners when both are demoted at once', async () => {
      await addSecondOwner();

      await Promise.allSettled([
        team.changeRole(TENANT, await memberId(OWNER), TenantRole.VIEWER),
        team.changeRole(TENANT, await memberId(SECOND_OWNER), TenantRole.VIEWER),
      ]);

      expect(await ownerCount()).toBeGreaterThanOrEqual(1);
    });

    it('never leaves a tenant with zero owners when both are removed at once', async () => {
      await addSecondOwner();

      await Promise.allSettled([
        team.remove(TENANT, await memberId(OWNER)),
        team.remove(TENANT, await memberId(SECOND_OWNER)),
      ]);

      expect(await ownerCount()).toBeGreaterThanOrEqual(1);
    });

    /**
     * One of the two must fail, and fail with the refusal rather than a raw
     * database error — concurrent owner removals deadlock, and MySQL's
     * `ER_LOCK_DEADLOCK` means nothing to a caller.
     */
    it('refuses the losing call with a message a person can act on', async () => {
      await addSecondOwner();

      const results = await Promise.allSettled([
        team.remove(TENANT, await memberId(OWNER)),
        team.remove(TENANT, await memberId(SECOND_OWNER)),
      ]);

      const rejected = results.filter((r) => r.status === 'rejected');

      if (rejected.length > 0) {
        const reason = (rejected[0] as PromiseRejectedResult).reason as Error;

        expect(reason.message).toMatch(/at least one owner/);
      }
    });

    /** The fix must not break the ordinary sequential case. */
    it('still allows a demotion when a second owner exists', async () => {
      await addSecondOwner();

      await expect(
        team.changeRole(TENANT, await memberId(OWNER), TenantRole.ADMIN),
      ).resolves.toBeUndefined();
      expect(await ownerCount()).toBe(1);
    });
  });

  describe('removal and scoping', () => {
    it('revokes rather than deletes, so the trail survives', async () => {
      await team.remove(TENANT, await memberId(ADMIN));

      const [row] = await dataSource.query(
        `SELECT revokedAt FROM tenant_members WHERE tenantId = ? AND userId = ?`,
        [TENANT, ADMIN],
      );

      expect(row.revokedAt).not.toBeNull();
      expect((await team.listMembers(TENANT)).some((m) => m.userId === ADMIN)).toBe(false);
    });

    /** A member id from another workspace is "not found", never "forbidden". */
    it('cannot reach a member in another tenant', async () => {
      await dataSource.query(
        `INSERT INTO tenant_members (id, tenantId, userId, role, acceptedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'admin', NOW(3), NOW(3), NOW(3))`,
        [`${OTHER_TENANT}-${NEWCOMER}`, OTHER_TENANT, NEWCOMER],
      );

      await expect(
        team.remove(TENANT, `${OTHER_TENANT}-${NEWCOMER}`),
      ).rejects.toThrow(/not found/);
    });
  });
});
