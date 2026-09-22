import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiError } from '../api/error';

/**
 * Put an API validation failure onto the form that caused it.
 *
 * The API's `ErrorDetail.field` is a **dotted path** — `groups.0.label` — which
 * is React Hook Form's own field-path format, so this is a copy rather than a
 * translation. That is not a coincidence to rely on silently: it is asserted in
 * `api-errors.test.ts`, so a change on either side is caught here rather than by
 * a merchant seeing an error attached to nothing.
 *
 * @returns Whether every detail found a home. `false` means at least one message
 *          must also be shown at form level, or the merchant sees a rejected
 *          form with no visible reason.
 */
export function applyApiErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  knownFields: ReadonlyArray<Path<T>>,
): boolean {
  if (!(error instanceof ApiError) || !error.isValidation) {
    return false;
  }

  let allPlaced = true;

  for (const detail of error.details) {
    const field = detail.field as Path<T>;

    /*
     * Only fields the form actually renders. Setting an error on an unknown path
     * makes RHF hold a message nothing displays -- the form stays invalid, the
     * submit button stays disabled, and nothing on screen says why.
     */
    if (knownFields.includes(field)) {
      setError(field, {
        type: 'server',
        message: messageFor(detail.code, detail.params?.message),
      });
    } else {
      allPlaced = false;
    }
  }

  return allPlaced;
}

/**
 * A message a merchant can act on.
 *
 * The API's own sentence lives at `params.message` — details are kept structured
 * so a client can localise them — and it is developer-facing prose, so `code` is
 * preferred and the sentence is the fallback.
 *
 * ⚠️ Today every validation detail carries `code: 'INVALID'`, because
 * `toValidationDetails()` maps class-validator's output that way. So the
 * fallback is the common path rather than the exception, and the switch below is
 * ready for the day the API sends a more specific code.
 */
function messageFor(code: string, message?: string): string {
  /*
   * The API's own sentence wins when there is one.
   *
   * Every validation detail today carries `code: 'INVALID'` -- that is how
   * `toValidationDetails()` maps class-validator's output -- so preferring the
   * code would replace *every* specific message with "This is not valid.",
   * including "password must be at most 72 bytes (120 given)". The code is the
   * fallback for details that carry no wording, not the other way round.
   */
  if (message !== undefined && message.length > 0) {
    return message;
  }

  switch (code) {
    case 'REQUIRED':
      return 'This is required.';
    case 'TOO_LONG':
      return 'This is too long.';
    case 'TOO_SHORT':
      return 'This is too short.';
    case 'ALREADY_EXISTS':
      return 'That is already taken.';
    default:
      return 'This is not valid.';
  }
}

/**
 * What to show above the form when the failure is not field-level.
 *
 * A 403, a 409, a network failure — none of them belong beside an input, and all
 * of them need saying.
 */
export function formLevelMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.isValidation) {
      return null;
    }

    switch (error.code) {
      case 'UNAUTHENTICATED':
        return 'Your session has ended. Sign in again.';
      case 'EMAIL_NOT_VERIFIED':
        /*
         * Not a permissions problem, and saying so sends a merchant to their
         * team owner instead of to their inbox. The screen that shows this also
         * offers to resend -- see the login page.
         */
        return 'Verify your email address before signing in. Check your inbox for the link.';
      case 'INSUFFICIENT_ROLE':
      case 'FORBIDDEN':
        return 'You do not have permission to do that.';
      case 'RATE_LIMITED':
        return 'Too many attempts. Wait a moment and try again.';
      default:
        return error.message;
    }
  }

  if (error instanceof Error && error.name === 'NetworkError') {
    return 'Could not reach the server. Check your connection and try again.';
  }

  return error === null || error === undefined ? null : 'Something went wrong.';
}
