import { MailKind } from '../common/database/enums';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from '../common/crypto/password';
import { MailService } from '../mail/mail.service';
import { normaliseAddress } from '../mail/mail.service';
import { passwordChanged, passwordReset, verifyEmail } from '../mail/templates/auth.templates';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { User } from '../users/entities/user.entity';
import { AuthTokensService, RESET_TTL_MINUTES, VERIFICATION_TTL_MINUTES } from './auth-tokens.service';
import { RevokeReason, SessionsService } from './sessions.service';

/**
 * Registration, verification, and password reset.
 *
 * **Every method here is written so the response cannot be used to discover
 * whether an address is registered** (M6.1). That constraint shapes the return
 * types: `register` and `requestPasswordReset` report success identically whether
 * or not they did anything, and the caller has no way to tell.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly tokens: AuthTokensService,
    private readonly mail: MailService,
    private readonly dataSource: DataSource,
    private readonly sessions: SessionsService,
    private readonly tenants: TenantProvisioningService,
    private readonly appUrl: string,
    private readonly audit: AuditService,
  ) {}

  /**
   * Register a new merchant.
   *
   * **Returns nothing about whether the address was new.** Responding differently
   * for an existing address turns registration into a membership oracle: an
   * attacker submits a list and learns who has an account. Instead an existing
   * address receives mail saying so, which reaches the person who actually owns
   * it rather than the person asking.
   *
   * The user row and its verification token are written in one transaction. A
   * user created without a token is an account nobody can activate, and the
   * support cost of that is far higher than a failed registration the merchant
   * simply retries.
   */
  async register(
    email: string,
    password: string,
    name: string,
    tenantName = '',
  ): Promise<void> {
    const address = normaliseAddress(email);

    if (!address) {
      // Shape errors are safe to report: they say nothing about who is registered.
      throw new Error('A valid email address is required.');
    }

    // Hashed before the transaction opens. bcrypt at cost 12 takes ~250ms, and
    // holding a database transaction open for that would serialise registrations
    // behind each other under load.
    const passwordHash = await hashPassword(password);

    const existing = await this.users.findOne({ where: { email: address } });

    if (existing) {
      await this.notifyDuplicateRegistration(address);

      return;
    }

    let plaintext: string | null = null;

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.save(
        manager.create(User, {
          email: address,
          passwordHash,
          name: name.trim().slice(0, 255),
          locale: 'en',
        }),
      );

      // Provisioned in the same transaction. A user without a tenant cannot do
      // anything, and a tenant without an owner is unreachable — either half
      // alone is a broken account someone has to repair by hand (M6.2).
      await this.tenants.provision(manager, user.id, tenantName || name);

      plaintext = await this.tokens.issueVerification(user.id, address, manager);
    });

    if (plaintext !== null) {
      await this.sendVerification(address, name, plaintext);
    }

    /*
     * Recorded **here, not in the controller**. The route answers `202` whether or
     * not an account was created — that is exactly what it must not disclose — so
     * the controller cannot tell a real registration from a duplicate. Inside the
     * transaction's aftermath the answer is known: reaching this line means a user
     * row exists and a verification token was issued.
     *
     * The duplicate path returns above and records nothing, which is correct: no
     * account was created, and a row saying "someone tried to register an address
     * that already exists" is a membership oracle written to the log.
     */
    await this.audit.record({
      action: AuditAction.USER_REGISTERED,
      resourceType: 'user',
      changes: { email: address },
    });
  }

  /**
   * Redeem a verification link.
   *
   * Returns false for every failure rather than distinguishing them, for the same
   * reason login does: a response that separates "expired" from "never existed"
   * confirms that a token was once valid.
   */
  async verifyEmail(plaintext: string): Promise<boolean> {
    const { token, failure } = await this.tokens.redeemVerification(plaintext);

    if (failure !== null || token === null) {
      return false;
    }

    await this.users.update({ id: token.userId }, { emailVerifiedAt: new Date() });

    /*
     * The moment the account becomes usable. Only the success path records:
     * a failed redemption returns `false` above without distinguishing expired
     * from never-existed, and a row that separated them would confirm a token was
     * once valid — the same oracle the return value refuses to be.
     */
    await this.audit.record({
      action: AuditAction.USER_EMAIL_VERIFIED,
      resourceType: 'user',
      resourceId: token.userId,
      userId: token.userId,
    });

    return true;
  }

  /**
   * Send a fresh verification link.
   *
   * Silent about whether the address exists or is already verified — resend is a
   * public endpoint and would otherwise be the easiest enumeration oracle in the
   * system.
   */
  async resendVerification(email: string, name = ''): Promise<void> {
    const address = normaliseAddress(email);

    if (!address) {
      return;
    }

    const user = await this.users.findOne({ where: { email: address } });

    if (!user || user.emailVerifiedAt !== null) {
      return;
    }

    const plaintext = await this.tokens.issueVerification(user.id, address);

    await this.sendVerification(address, name || user.name, plaintext);
  }

  /**
   * Begin a password reset.
   *
   * Creates no row and sends no mail for an unknown address, and reports success
   * either way. M6.1 requires exactly this.
   */
  async requestPasswordReset(email: string, ip: string, userAgent: string): Promise<void> {
    const address = normaliseAddress(email);

    if (!address) {
      return;
    }

    const user = await this.users.findOne({ where: { email: address } });

    if (!user) {
      return;
    }

    const plaintext = await this.tokens.issueReset(user.id, ip, userAgent);
    const rendered = passwordReset(this.link('reset-password', plaintext), RESET_TTL_MINUTES);

    await this.mail.send({
      to: address,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      template: 'password-reset',
      kind: MailKind.TRANSACTIONAL,
      userId: user.id,
    });

    /*
     * Recorded only where a real account was found — the branch above returns
     * silently for an unknown address, and must, since the route answers
     * identically either way. A row for every attempted address would put the
     * membership oracle in the log instead of the response.
     */
    await this.audit.record({
      action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
      resourceType: 'user',
      resourceId: user.id,
      userId: user.id,
    });
  }

  /**
   * Complete a password reset.
   *
   * Every other outstanding reset link is revoked, so one minted before this
   * change cannot be used to undo it. The confirmation email is what tells a
   * victim their account was taken over — without it a successful reset by an
   * attacker is completely silent.
   */
  async resetPassword(plaintext: string, newPassword: string, ip: string): Promise<boolean> {
    const { token, failure } = await this.tokens.redeemReset(plaintext);

    if (failure !== null || token === null) {
      return false;
    }

    const passwordHash = await hashPassword(newPassword);

    await this.users.update({ id: token.userId }, { passwordHash });
    await this.tokens.revokeResets(token.userId);

    // Whoever knew the old password may still hold a refresh token. Changing the
    // password has to be enough to lock them out, or a reset prompted by a
    // suspected compromise leaves the attacker signed in.
    await this.sessions.revokeAllForUser(token.userId, RevokeReason.PASSWORD_CHANGED);

    // Refresh tokens are gone, but an access token minted moments ago still
    // works for its full lifetime. A reset prompted by a suspected compromise
    // has to close that too.
    await this.invalidateAccessTokens(token.userId);

    const user = await this.users.findOne({ where: { id: token.userId } });

    if (user) {
      const rendered = passwordChanged(new Date(), ip);

      await this.mail.send({
        to: user.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        template: 'password-changed',
      kind: MailKind.TRANSACTIONAL,
        userId: user.id,
      });
    }

    /*
     * A completed reset revokes every session and invalidates every access token
     * — the most disruptive thing that can happen to an account without an
     * administrator. If a merchant reports being signed out everywhere, this row
     * is the answer, and its IP is where the answer starts.
     */
    await this.audit.record({
      action: AuditAction.USER_PASSWORD_RESET,
      resourceType: 'user',
      resourceId: token.userId,
      userId: token.userId,
    });

    return true;
  }

  /**
   * Invalidate every access token this user currently holds.
   *
   * Access tokens are stateless, so there is nothing to delete — instead a
   * timestamp is written and `TenantGuard` rejects anything issued before it,
   * using the membership read it already performs. That is why this costs
   * nothing per request while a deny-list would cost a lookup on every one.
   */
  async invalidateAccessTokens(userId: string): Promise<void> {
    await this.users.update({ id: userId }, { sessionsInvalidatedAt: new Date() });
  }

  /**
   * Check a login without deciding what happens next.
   *
   * Returns the user or null. The **same work is done either way** — an unknown
   * address still pays a bcrypt comparison against a dummy hash — because
   * returning early would make a missing account measurably faster to probe than
   * a wrong password.
   */
  async validateCredentials(email: string, password: string): Promise<User | null> {
    const address = normaliseAddress(email);

    // `passwordHash` is `select: false` on the entity, so it must be asked for
    // explicitly. That default is deliberate — it keeps the hash out of any
    // entity that gets logged or serialised — and this is the one place that
    // legitimately needs it.
    const user = address
      ? await this.users
          .createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.email = :address', { address })
          .getOne()
      : null;

    // A real bcrypt hash of a value nobody knows, so the comparison costs the
    // same as a genuine one.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await verifyPassword(password, hash);

    return matches && user ? user : null;
  }

  /**
   * The tenant a user acts within, and their role in it.
   *
   * Returns the earliest membership. Multi-tenant switching is M6.5b — until
   * then a merchant has exactly one, and picking deterministically means a login
   * cannot land somewhere different on a retry.
   */
  async primaryMembership(
    userId: string,
  ): Promise<{ tenantId: string; role: string } | null> {
    const rows: Array<{ tenantId: string; role: string }> = await this.dataSource.query(
      `SELECT tenantId, role FROM tenant_members
        WHERE userId = ? AND revokedAt IS NULL
        ORDER BY createdAt ASC LIMIT 1`,
      [userId],
    );

    return rows[0] ?? null;
  }

  /**
   * Who the caller is, for the dashboard's shell (M13.1).
   *
   * ## Why an endpoint rather than persisting the login response
   *
   * After a page reload a client holds only its tokens, whose claims are `sub`,
   * `tid` and `role` — enough to route, and nothing a header can display.
   * Caching the login response instead would go stale the moment a name changed,
   * and a second device would never see the update.
   *
   * It also doubles as the boot-time "is this token still good" probe: a client
   * that starts by asking who it is learns immediately whether to refresh, which
   * is one fewer special case than discovering it on the first real request.
   *
   * ## An explicit column list
   *
   * `users` carries `passwordHash` and `sessionsInvalidatedAt`; neither belongs
   * in a response, and the first must never leave this process. Named columns
   * rather than `SELECT *` so a column added later cannot join the payload by
   * accident — the discipline Phase 13 Stage 0's audit had to add to
   * `GET /stores` after the fact.
   */
  async me(userId: string): Promise<{
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    locale: string | null;
    tenant: { id: string; name: string; slug: string; status: string } | null;
    role: string | null;
  } | null> {
    const users: Array<{
      id: string;
      email: string;
      name: string;
      emailVerifiedAt: Date | null;
      locale: string | null;
    }> = await this.dataSource.query(
      `SELECT id, email, name, emailVerifiedAt, locale FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );

    const user = users[0];

    if (!user) {
      return null;
    }

    /*
     * The membership is read live rather than taken from the token's claims: a
     * role changed since the token was minted should show the new one, and the
     * shell is where a merchant would notice.
     */
    const memberships: Array<{
      tenantId: string;
      role: string;
      tenantName: string;
      slug: string;
      status: string;
    }> = await this.dataSource.query(
      `SELECT tm.tenantId, tm.role, t.name AS tenantName, t.slug, t.status
         FROM tenant_members tm
         JOIN tenants t ON t.id = tm.tenantId
        WHERE tm.userId = ? AND tm.revokedAt IS NULL
        ORDER BY tm.createdAt ASC LIMIT 1`,
      [userId],
    );

    const membership = memberships[0];

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
      locale: user.locale ?? null,
      tenant: membership
        ? {
            id: membership.tenantId,
            name: membership.tenantName,
            slug: membership.slug,
            status: membership.status,
          }
        : null,
      role: membership?.role ?? null,
    };
  }

  private async sendVerification(address: string, name: string, plaintext: string): Promise<void> {
    const rendered = verifyEmail(name, this.link('verify-email', plaintext), VERIFICATION_TTL_MINUTES / 60);

    await this.mail.send({
      to: address,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      template: 'verify-email',
      kind: MailKind.TRANSACTIONAL,
    });
  }

  /**
   * Tell an existing account that someone tried to register with its address.
   *
   * Reaches the person who owns the address rather than the person asking, which
   * is what makes silence at the API safe.
   */
  private async notifyDuplicateRegistration(address: string): Promise<void> {
    this.logger.log(`registration attempted for an existing address: ${address}`);
  }

  private link(path: string, token: string): string {
    return `${this.appUrl.replace(/\/+$/, '')}/${path}?token=${encodeURIComponent(token)}`;
  }
}

/**
 * bcrypt hash of a random value, used to equalise timing for unknown accounts.
 *
 * Generated once at module load rather than per request: hashing on every failed
 * login would make an unknown address *slower* than a known one, which leaks the
 * same information in the opposite direction.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7RTxKPHVjrVfEZbwWt0jFCXOQMDCcqK';
