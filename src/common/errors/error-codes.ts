import { HttpStatus } from '@nestjs/common';

/**
 * Error codes are a public contract. See ADR-010.
 *
 * `message` is for humans and may change freely. `code` is for machines and may
 * not — clients branch on it, so changing one is a breaking API change.
 */
export const ErrorCode = {
  // 400 — the request is malformed or fails validation.
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // 401 — no valid credential.
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',

  // 403 — authenticated, but not permitted.
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  /**
   * Credentials are correct; the address has not been verified.
   *
   * Distinct from `FORBIDDEN` because the remedies are opposite: a permissions
   * failure means *ask someone else*, and this means *open your email*. Sharing
   * one code left a client unable to tell them apart — an unverified merchant
   * was shown "You do not have permission to do that", which is both wrong and
   * a dead end, since the resend screen needs a session sign-in had just
   * refused.
   *
   * Added 2026-09-02 by Phase 13 Stage 2's audit, found by signing in with an
   * unverified account rather than by reading the handler.
   */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  // 404 — no such resource, or none visible to this caller.
  NOT_FOUND: 'NOT_FOUND',

  // 409 — the request conflicts with current state.
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  VERSION_MISMATCH: 'VERSION_MISMATCH',

  // 429 — a limit was reached.
  RATE_LIMITED: 'RATE_LIMITED',
  PLAN_LIMIT_EXCEEDED: 'PLAN_LIMIT_EXCEEDED',

  // 5xx — our fault.
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The HTTP status each code maps to.
 *
 * Declared as data rather than decided per throw site, so the same condition
 * cannot return 403 in one module and 404 in another.
 */
export const ERROR_STATUS: Record<ErrorCodeValue, HttpStatus> = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.MALFORMED_JSON]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,

  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_INVALID]: HttpStatus.UNAUTHORIZED,

  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.EMAIL_NOT_VERIFIED]: HttpStatus.FORBIDDEN,
  [ErrorCode.INSUFFICIENT_ROLE]: HttpStatus.FORBIDDEN,

  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,

  [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [ErrorCode.VERSION_MISMATCH]: HttpStatus.CONFLICT,

  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.PLAN_LIMIT_EXCEEDED]: HttpStatus.TOO_MANY_REQUESTS,

  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ErrorCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
};
