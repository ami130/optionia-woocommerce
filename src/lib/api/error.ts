import type { ApiErrorBody, ApiErrorDetail } from './types';

/**
 * A failed request, carrying what the API said rather than a string.
 *
 * The status decides routing (401 signs out, 403 is a permissions message), the
 * `code` decides copy, and `details` map onto form fields. Flattening any of
 * that into `new Error(message)` at the transport layer means every caller
 * re-parses prose.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody, requestId?: string) {
    super(body.message);

    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? [];
    this.requestId = requestId;
  }

  /** Field-level failures, if the API named any. */
  get isValidation(): boolean {
    return this.details.length > 0;
  }
}

/**
 * A failure with no response at all — the API is unreachable.
 *
 * Distinct from `ApiError` because the remedies differ: a `400` is the user's to
 * fix, and this one is not. A retry button belongs on this and not on that.
 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server.');

    this.name = 'NetworkError';
    this.cause = cause;
  }
}
