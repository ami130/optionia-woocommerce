import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a write as permitted while a subscription has lapsed. */
export const WRITABLE_WHEN_LAPSED = 'subscription:writable-when-lapsed';

/**
 * Allow a write even when the tenant's grace period has expired (ADR-116).
 *
 * `SubscriptionGuard` is global and refuses every tenant-realm mutation once a
 * subscription lapses, so this is the only way through and **every use is
 * visible in a grep**. The inverse default — opt in to enforcement — is what
 * the last four instances of this project's dominant defect looked like: a
 * guard that has to be remembered is a guard that is forgotten.
 *
 * ## What legitimately carries it
 *
 * 🔴 **Anything a lapsed merchant needs in order to stop being lapsed.** A
 * read-only state that blocks the checkout which would lift it is a trap, not a
 * policy — the merchant cannot pay, so the state never ends, and ADR-116's
 * whole argument is that pressure should apply *where it converts*.
 *
 * ⚠️ **Nothing else.** Not "small" edits, not "harmless" ones: the policy
 * merchants are shown says authoring pauses, and a route that quietly keeps
 * working makes that sentence false.
 */
export const WritableWhenLapsed = (): MethodDecorator & ClassDecorator =>
  SetMetadata(WRITABLE_WHEN_LAPSED, true);
