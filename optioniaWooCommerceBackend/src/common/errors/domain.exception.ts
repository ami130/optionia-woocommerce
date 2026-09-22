import { HttpException } from '@nestjs/common';

import { ERROR_STATUS, ErrorCode, type ErrorCodeValue } from './error-codes';
import type { ErrorDetail } from '../http/api-response.types';

/**
 * The single way business code signals a failure.
 *
 * Extends `HttpException` so Nest's own handling still applies, but carries a
 * stable `code` rather than only a status. The status is looked up from the
 * code (see `ERROR_STATUS`) rather than passed in, so the same condition cannot
 * return 403 in one module and 404 in another.
 */
export class DomainException extends HttpException {
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super({ code, message, details }, ERROR_STATUS[code]);
  }

  /**
   * A resource does not exist, or is not visible to this caller.
   *
   * ⚠️ **Also the correct response to a cross-tenant access attempt.**
   *
   * Returning `FORBIDDEN` there would confirm the resource exists, turning an
   * authorization boundary into an enumeration oracle: an attacker walks ids and
   * learns which belong to other tenants from the status code alone. From
   * outside the tenant, the resource does not exist. See ADR-010.
   *
   * @param resource Resource type, used only in the human-readable message.
   */
  static notFound(resource: string): DomainException {
    return new DomainException(ErrorCode.NOT_FOUND, `${resource} not found.`);
  }

  /** Input failed validation. Details are per-field and structured. */
  static validation(details: ErrorDetail[]): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'The request contains invalid fields.',
      details,
    );
  }

  /** The request conflicts with current state. */
  static conflict(message: string): DomainException {
    return new DomainException(ErrorCode.CONFLICT, message);
  }

  /**
   * An optimistic-lock failure: the caller's version is stale.
   *
   * Distinct from a plain conflict because the client can act on it — reload,
   * show the difference, and let the user decide. See M7.4b.
   *
   * **Carries the current version**, because a 409 that only says "you are
   * stale" leaves the dashboard with nothing to offer but an error toast. With
   * the server's version the client can fetch what changed and present a real
   * choice — reload and lose local edits, or review the difference — which is
   * the whole point of designing out silent overwrite rather than merely
   * detecting it.
   */
  static versionMismatch(message: string, current?: number): DomainException {
    return new DomainException(
      ErrorCode.VERSION_MISMATCH,
      message,
      current === undefined
        ? undefined
        : [{ field: 'rowVersion', code: 'STALE', params: { current } }],
    );
  }

  /** Authenticated, but lacking the required role or capability. */
  static forbidden(message = 'You are not permitted to perform this action.'): DomainException {
    return new DomainException(ErrorCode.FORBIDDEN, message);
  }

  /** No valid credential was presented. */
  static unauthenticated(message = 'Authentication is required.'): DomainException {
    return new DomainException(ErrorCode.UNAUTHENTICATED, message);
  }

  /** A subscription plan limit was reached. Carries the limit for the UI. */
  static planLimit(message: string, details?: ErrorDetail[]): DomainException {
    return new DomainException(ErrorCode.PLAN_LIMIT_EXCEEDED, message, details);
  }
}
