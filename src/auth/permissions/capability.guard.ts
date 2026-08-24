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
      // A route behind this guard must say what it requires.
      //
      // Returning true here was the previous behaviour, justified by a comment
      // claiming a test asserted every mutating route declares a capability. No
      // such test existed, and a probe confirmed the consequence: a `viewer`
      // reached a publish route and got 200.
      //
      // Failing closed costs a developer one clear error the first time they add
      // a route. Failing open costs a merchant their storefront, and does it
      // silently.
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'This action is not available.',
      );
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
