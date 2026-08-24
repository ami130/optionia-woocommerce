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
