import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as unauthenticated. */
export const IS_PUBLIC = 'auth:public';

/**
 * Mark a route as reachable without a token.
 *
 * Authentication is global, so this is the only way in and every use is visible
 * in a grep. The inverse default — opt in to protection — makes forgetting the
 * decorator a security hole rather than a 401 during development.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Undo a class-level `@Public()` for one route.
 *
 * `AuthController` is `@Public()` because a caller signing in has no token yet —
 * but `GET /auth/me` is the opposite, and moving it to another controller for
 * the sake of a decorator would put the session endpoints in two places.
 *
 * `JwtAuthGuard` reads this with `getAllAndOverride([handler, class])`, which
 * takes the **handler** first, so `false` here wins over `true` on the class.
 * Added 2026-09-02 for Phase 13 Stage 1; before it, a route-level guard on a
 * public controller silently admitted everyone — the guard stood aside, nothing
 * populated the request context, and the handler answered `401` for a caller
 * holding a perfectly valid token.
 *
 * Named rather than written as a bare `SetMetadata(IS_PUBLIC, false)` so the
 * exception is as greppable as the rule.
 */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, false);
