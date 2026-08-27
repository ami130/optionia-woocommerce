import { ValidationError } from '@nestjs/common';

/**
 * Flatten class-validator's tree into one entry per failed constraint.
 *
 * A single field can fail several constraints, and each is a separate thing the
 * user has to fix — collapsing them would hide all but one.
 *
 * Nested properties are joined with a dot (`address.postcode`), which is the
 * path a client already uses to find the input. ADR-009 promises per-field
 * details; this is what makes them true rather than aspirational.
 *
 * ## Why this is not private to `main.ts`
 *
 * It was, and every e2e suite needing the production error shape rewrote it.
 * The rewrites drifted: `auth-http` had a version reading `error.property`
 * directly, which **loses the nested path** — reporting `postcode` where the
 * application reports `address.postcode`. A suite asserting on that shape is
 * asserting on a shape nothing ships.
 *
 * Exported so `main.ts` and the test harness resolve to one implementation.
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Array<{ field: string; message: string }> {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;

    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field: path,
      message,
    }));

    const nested = error.children?.length ? flattenValidationErrors(error.children, path) : [];

    return [...own, ...nested];
  });
}
