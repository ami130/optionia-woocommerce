import { SetMetadata } from '@nestjs/common';

import type { Capability } from './capabilities';

/** Metadata key carrying the capability a route requires. */
export const REQUIRED_CAPABILITY = 'auth:capability';

/**
 * Declare what a route requires.
 *
 * One capability per route, not a list. A route needing two unrelated
 * permissions is usually two routes, and an implicit AND/OR would be a policy
 * decision hidden in a decorator.
 */
export const RequireCapability = (capability: Capability): MethodDecorator =>
  SetMetadata(REQUIRED_CAPABILITY, capability);
