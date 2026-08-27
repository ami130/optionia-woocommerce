import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

import { ErrorCode } from '../errors/error-codes';

/**
 * The error envelope, as the spec describes it.
 *
 * Declared once. Every failure this API returns has the same shape — a stable
 * `code`, a human `message`, and optional per-field `details` (ADR-009) — so
 * describing it per route would be the same object written forty times, with
 * forty chances to drift.
 */
export class ApiErrorDetailSchema {
  /** Dotted path to the offending field, e.g. `groups.0.label`. */
  @ApiProperty({ type: String })
  field: string;

  /** Machine-readable reason, e.g. `TOO_LONG`. */
  @ApiProperty({ type: String })
  code: string;

  /** Values for message interpolation, e.g. `{ max: 60 }`. */
  @ApiPropertyOptional({ type: Object })
  params?: Record<string, unknown>;
}

export class ApiErrorSchema {
  /** Stable and machine-readable. A public contract — never changed casually. */
  @ApiProperty({ type: String })
  code: string;

  /** Human-readable. May change freely; clients must not parse it. */
  @ApiProperty({ type: String })
  message: string;

  /** Field-level failures. Present on validation errors. */
  @ApiPropertyOptional({ type: () => [ApiErrorDetailSchema] })
  details?: ApiErrorDetailSchema[];
}

export class ApiErrorResponseSchema {
  @ApiProperty({ type: () => ApiErrorSchema })
  error: ApiErrorSchema;
}

/**
 * The failures a route can return, in the spec.
 *
 * ## Why this exists
 *
 * The generated spec described **no error responses at all** — only `200`,
 * `201`, `202`, `204` — while `docs/API-CONTRACT.md` documents sixteen error
 * codes and their statuses. A generated client had no failure types, and the one
 * machine-readable document omitted every way a call can go wrong.
 *
 * ## Why it is a decorator rather than a global
 *
 * Not every route can return every status. A `GET` cannot answer `409`, and a
 * route with no body cannot answer `400`. Listing them per route means the spec
 * says what is actually possible, and adding a status is a deliberate act rather
 * than a side effect of a global default.
 */
/**
 * The success status a route returns, declared alongside its failures.
 *
 * **Required, not optional.** Adding an `ApiResponse` to a method suppresses the
 * automatic success response Nest would otherwise infer — so declaring only
 * errors leaves an operation with no `2xx` at all, which is worse than the
 * missing errors it set out to fix. Verified: applying errors alone stripped the
 * success status from all 33 guarded operations.
 */
export function ApiErrors(
  success: number,
  ...statuses: number[]
): MethodDecorator & ClassDecorator {
  const described: Record<number, { code: string; description: string }> = {
    400: { code: ErrorCode.VALIDATION_FAILED, description: 'The request failed validation.' },
    401: { code: ErrorCode.UNAUTHENTICATED, description: 'Missing or invalid credentials.' },
    403: {
      code: ErrorCode.INSUFFICIENT_ROLE,
      description: 'Authenticated, but lacking the required capability.',
    },
    404: {
      code: ErrorCode.NOT_FOUND,
      // Stated here because a client acting on the difference would be wrong.
      description:
        'Not found. A resource belonging to another tenant answers the same way, ' +
        'so a caller cannot learn that an id is real (ADR-010).',
    },
    409: {
      code: ErrorCode.CONFLICT,
      description:
        'The request conflicts with current state — a stale `rowVersion`, a ' +
        'duplicate key, or a transient lock conflict a retry may resolve.',
    },
    429: { code: ErrorCode.RATE_LIMITED, description: 'Rate limit exceeded.' },
  };

  const successDescriptions: Record<number, string> = {
    200: 'Success.',
    201: 'Created.',
    202: 'Accepted.',
    204: 'Success, with no body.',
  };

  return applyDecorators(
    ApiExtraModels(ApiErrorResponseSchema),
    ApiResponse({ status: success, description: successDescriptions[success] ?? 'Success.' }),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: described[status]?.description ?? 'Error.',
        schema: { $ref: getSchemaPath(ApiErrorResponseSchema) },
      }),
    ),
  );
}
