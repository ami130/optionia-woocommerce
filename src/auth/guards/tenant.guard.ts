import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TenantMember } from '../../tenants/entities/tenant-member.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Confirms the caller is still a member of the tenant their token names.
 *
 * **The token's `tid` claim is not trusted on its own.** An access token lives
 * for minutes and cannot be revoked, so a member removed from a tenant would keep
 * working until their token expired — which is exactly the window that matters
 * when someone is removed for cause.
 *
 * The membership row is therefore read on every request. That is one indexed
 * lookup on a primary-key join, and the alternative is an authorization decision
 * based on a claim that was true when it was minted.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @InjectRepository(TenantMember)
    private readonly members: Repository<TenantMember>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async canActivate(_context: ExecutionContext): Promise<boolean> {
    const ctx = getContext();

    if (!ctx?.userId || !ctx.tenantId) {
      // No identity means JwtAuthGuard did not run or did not resolve one.
      // Ordering is a wiring mistake, not a caller error, but the response is
      // still a plain 401 rather than anything that describes our internals.
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const membership = await this.members.findOne({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, revokedAt: IsNull() },
    });

    if (membership === null) {
      // 401, not 403. A 403 would confirm the tenant exists and that this user
      // is simply not in it — from outside a tenant, it does not exist (ADR-010).
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    /**
     * Reject a token issued before this user's sessions were invalidated.
     *
     * Logout and password reset set that timestamp. Without this an access token
     * kept working for the rest of its lifetime after logout — measured at 15
     * minutes — because a stateless token cannot be revoked individually.
     *
     * `iat` is in seconds and the column has millisecond precision, so the
     * comparison rounds the timestamp down: a token minted in the same second as
     * the invalidation is rejected rather than kept. Erring toward rejection is
     * correct here — the cost is one unnecessary re-login, against a session that
     * should have ended.
     */
    if (ctx.tokenIssuedAt !== undefined) {
      const user = await this.users.findOne({
        where: { id: ctx.userId },
        select: { id: true, sessionsInvalidatedAt: true },
      });

      const invalidatedAt = user?.sessionsInvalidatedAt;

      if (invalidatedAt && Math.floor(invalidatedAt.getTime() / 1000) >= ctx.tokenIssuedAt) {
        throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
      }
    }

    // The stored role wins over the token's copy. A demotion has to take effect
    // immediately, and the token was minted before it happened.
    ctx.tenantRole = membership.role;

    return true;
  }
}
