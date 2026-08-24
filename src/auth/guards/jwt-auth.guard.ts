import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AuthJwtService, TokenAudience } from '../jwt.service';
import { IS_PUBLIC } from './public.decorator';

/**
 * Requires a valid access token from the tenant realm.
 *
 * **Every failure is the same 401.** A missing header, an expired token, a bad
 * signature and a token from the wrong realm are indistinguishable to the
 * caller — telling an attacker which part of their forgery worked is telling
 * them how to fix it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: AuthJwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Opt-out is explicit and per-route. The guard is applied globally, so a new
    // endpoint is protected by default and has to say otherwise — the opposite
    // default would make forgetting the guard the security failure.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const claims = this.jwt.verify(bearerToken(request), TokenAudience.TENANT);

    if (claims === null) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    // Written into the request context rather than onto the request object, so
    // the data layer can read it without knowing about HTTP.
    const ctx = getContext();

    if (ctx) {
      ctx.userId = claims.sub;
      ctx.realm = 'tenant';
      ctx.tenantId = claims.tid;
      ctx.tenantRole = claims.role;
    }

    return true;
  }
}

/**
 * Extract a bearer token.
 *
 * Returns an empty string rather than throwing on a malformed header, so every
 * shape of failure reaches the same single rejection above.
 */
function bearerToken(request: Request): string {
  const header = request.headers.authorization ?? '';
  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value : '';
}
