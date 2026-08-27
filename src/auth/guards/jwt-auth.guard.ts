import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { getContext } from '../../common/context/request-context';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AuthJwtService, TokenAudience } from '../jwt.service';
import { IS_PUBLIC } from './public.decorator';
import { IS_STORE_ROUTE } from './store-route.decorator';

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

    /**
     * Stand aside for the store realm.
     *
     * A store presents an opaque credential, not a JWT, so this guard cannot
     * authenticate it — and rejecting it here would make `/store/*` unreachable
     * before `StoreTokenGuard` ever ran.
     *
     * **This is not an opt-out from authentication.** Returning true leaves the
     * request unauthenticated *by this guard*, and `StoreTokenGuard` must then
     * admit it: it sets `realm`, `tenantId` and the credential, and nothing in
     * the store realm works without them. A route marked `@StoreRoute()` that
     * forgets `StoreTokenGuard` therefore fails closed at the data layer —
     * `requireTenantId()` throws rather than returning unscoped rows.
     */
    const isStoreRoute = this.reflector.getAllAndOverride<boolean>(IS_STORE_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isStoreRoute) {
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
      ctx.tokenIssuedAt = claims.iat;
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
