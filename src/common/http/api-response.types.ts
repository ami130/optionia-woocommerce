/**
 * The response envelope.
 *
 * Every response the API returns — success or failure — has this shape. See
 * ADR-009 for why it is wrapped rather than returning resources directly.
 *
 * The short version: the WooCommerce plugin runs on merchant infrastructure we
 * cannot redeploy. A merchant may run a two-year-old version indefinitely, so
 * adding a field to a bare response body risks breaking a parser we cannot
 * update. `meta` is a permanent place to add things without touching `data`.
 */

/** Metadata attached to every response. */
export interface ResponseMeta {
  /**
   * Correlation id, echoed in the `X-Request-Id` header.
   *
   * Present on errors too, so a merchant support ticket can quote one value
   * that ties their symptom to a server log line.
   */
  requestId: string;

  /** ISO-8601 timestamp, generated server-side. */
  timestamp: string;

  /** Cursor pagination state. Present only on list endpoints. */
  pagination?: PaginationMeta;

  /** Deprecation notice. Present only when the route or version is sunsetting. */
  deprecation?: DeprecationMeta;
}

/**
 * Cursor pagination.
 *
 * Cursor rather than offset: option sets and products are inserted while a
 * merchant pages through them, and offset pagination silently skips or repeats
 * rows when that happens.
 */
export interface PaginationMeta {
  /** Opaque cursor for the next page. Null on the last page. */
  cursor: string | null;

  /** Whether another page exists. */
  hasMore: boolean;

  /** Page size actually applied, which may be lower than requested. */
  limit: number;
}

/** Deprecation signalling. Mirrors the `Deprecation` and `Sunset` headers. */
export interface DeprecationMeta {
  /** What is deprecated, and what replaces it. */
  message: string;

  /** ISO-8601 date after which this stops working. */
  sunsetAt: string;
}

/** A field-level validation failure. */
export interface ErrorDetail {
  /** Dotted path to the offending field, e.g. `groups.0.label`. */
  field: string;

  /** Machine-readable reason, e.g. `TOO_LONG`. */
  code: string;

  /**
   * Values for message interpolation, e.g. `{ max: 60 }`.
   *
   * Structured rather than pre-formatted English so the dashboard can render
   * the message next to the field and translate it. A sentence cannot be
   * localised after the fact.
   */
  params?: Record<string, unknown>;
}

/** The error body. See ADR-010 for the code taxonomy. */
export interface ApiError {
  /** Stable, SCREAMING_SNAKE_CASE. A public contract — never changed casually. */
  code: string;

  /** Human-readable summary. May change freely; clients must not parse it. */
  message: string;

  /** Field-level failures. Present on validation errors. */
  details?: ErrorDetail[];
}

/** A successful response. */
export interface ApiSuccessResponse<T> {
  data: T;
  meta: ResponseMeta;
}

/** A failed response. */
export interface ApiErrorResponse {
  error: ApiError;
  meta: ResponseMeta;
}

/** Any response this API returns. */
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Marks a controller return value as already-paginated.
 *
 * The interceptor unwraps this into `data` plus `meta.pagination`, so a
 * controller never assembles the envelope itself.
 */
export class PaginatedResult<T> {
  constructor(
    public readonly items: T[],
    public readonly pagination: PaginationMeta,
  ) {}
}
