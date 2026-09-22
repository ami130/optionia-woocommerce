import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as belonging to the store realm. */
export const IS_STORE_ROUTE = 'auth:store-route';

/**
 * Mark a route as authenticated by a **store credential** rather than a user JWT.
 *
 * ## Why this is not `@Public()`
 *
 * Authentication is global: `JwtAuthGuard` runs on every route and routes opt out
 * with `@Public()`. A store route cannot use that opt-out, because `@Public()`
 * means *no authentication at all* — if `StoreTokenGuard` were then missing,
 * misordered, or short-circuited, the route would be wide open and every test
 * would still pass. That is the fail-open shape this codebase has already been
 * bitten by once, in `CapabilityGuard`.
 *
 * This marker says something narrower and safer: *this route is authenticated,
 * but by a different realm*. `JwtAuthGuard` stands aside for it and
 * `StoreTokenGuard` must then admit the request — a route carrying this marker
 * with no `StoreTokenGuard` is unreachable rather than unprotected, because
 * nothing has authenticated it and no context realm is set.
 *
 * Every use is visible in one grep, exactly as `@Public()` is.
 */
export const StoreRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_STORE_ROUTE, true);
