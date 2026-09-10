/**
 * The shapes the API actually returns.
 *
 * Mirrored from `optioniaWooCommerceBackend/src/common/http/api-response.types.ts`
 * rather than imported: the two repositories ship separately, and a compile-time
 * dependency between them would make the dashboard unbuildable whenever the
 * backend is mid-change. The contract is `docs/API-CONTRACT.md`; these types are
 * this side's reading of it.
 */

/** Every successful response is wrapped. */
export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiMeta {
  requestId?: string;
  timestamp?: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  /** Opaque. Never construct one — echo it back verbatim. */
  cursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * A field-level validation failure.
 *
 * `field` is a **dotted path** (`groups.0.label`), which is React Hook Form's own
 * field-path format — so these map onto a form with no translation.
 */
export interface ApiErrorDetail {
  field: string;

  /** Machine-readable reason, e.g. `TOO_LONG`. */
  code: string;

  /**
   * Values for interpolation, e.g. `{ max: 60 }`.
   *
   * ⚠️ **The human sentence lives at `params.message`**, not at a top-level
   * `message` — the API keeps details structured so a client can localise them,
   * and `toValidationDetails()` puts class-validator's text in here. Verified
   * against the live API in Phase 13 Stage 2, after this type declared a
   * top-level `message` that was never populated: every field error would have
   * silently fallen back to generic copy.
   */
  params?: Record<string, unknown> & { message?: string };
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
  meta: ApiMeta;
}
