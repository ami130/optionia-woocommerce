import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { tenantRoleCan, type Capability } from './capabilities';
import { REQUIRED_CAPABILITY } from './require-capability.decorator';

/**
 * Enforces the permission matrix.
 *
 * **Server-side is the rule; the dashboard hiding a button is a courtesy.** A
 * client that hides what a role cannot do is being polite to the user; this is
 * what stops a `viewer` publishing by calling the endpoint directly.
 *
 * Runs after `TenantGuard`, which resolves the role from the membership row
 * rather than the token — so a demotion takes effect on the next request rather
 * than when the access token expires.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability | undefined>(
      REQUIRED_CAPABILITY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      // No declaration means no capability check. That is not a hole: the route
      // is still behind JwtAuthGuard and TenantGuard, and M6.6 asserts that every
      // mutating route declares one, so a missing decorator fails a test rather
      // than passing silently.
      return true;
    }

    const ctx = getContext();

    if (!ctx?.tenantId || !ctx.userId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    if (!tenantRoleCan(ctx.tenantRole, required)) {
      // 403, not 404. The caller is a legitimate member of this tenant and the
      // resource plainly exists — hiding that would be dishonest and would make
      // "why can't I publish?" unanswerable. Cross-*tenant* access is the case
      // that gets a 404 (ADR-010); this is cross-*role*.
      throw new DomainException(
        ErrorCode.INSUFFICIENT_ROLE,
        `Your role does not permit this action.`,
      );
    }

    return true;
  }
}
