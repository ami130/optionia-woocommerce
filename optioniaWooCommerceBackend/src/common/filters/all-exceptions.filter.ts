import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';

import { getRequestId } from '../context/request-context';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, WeakPasswordError } from '../crypto/password';
import { ErrorCode, type ErrorCodeValue } from '../errors/error-codes';
import { asUniqueViolation, isTransientLockConflict } from '../errors/unique-violation';
import type { ApiError, ApiErrorResponse, ErrorDetail } from '../http/api-response.types';

/** What `main.ts`'s exceptionFactory emits for each failed constraint. */
interface ValidationMessage {
  readonly field: string;
  readonly message: string;
}

/**
 * Converts every thrown value into the error envelope. See ADR-009, ADR-010.
 *
 * The rule this filter exists to enforce: **an unexpected error never leaks
 * detail to the client.** A `QueryFailedError` reaching a response body exposes
 * table and column names; a stack trace exposes file paths and library
 * versions. Both are logged in full against the request id, and the client
 * receives `INTERNAL_ERROR` with nothing else.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = getRequestId();

    const { status, error, logAsError } = this.translate(exception);

    // 5xx is our bug and gets a stack trace. 4xx is the caller's problem and is
    // logged at warn without one — otherwise a bot probing for endpoints fills
    // the error log and hides real failures.
    if (logAsError) {
      this.logger.error(
        { requestId, code: error.code, err: exception },
        `Unhandled exception: ${error.code}`,
      );
    } else {
      this.logger.warn({ requestId, code: error.code }, `Request failed: ${error.code}`);
    }

    /*
     * 🔴 **A response may already have been sent.**
     *
     * An error thrown *after* the handler replied — a serializer failing on the
     * way out, an interceptor, a stream that breaks mid-write — still reaches
     * this filter. Calling `.json()` then throws `ERR_HTTP_HEADERS_SENT`, and
     * because that throw happens inside the filter itself there is nothing left
     * to catch it: it escapes as an unhandled exception and **destroys the
     * connection**.
     *
     * The client sees no response and no error. It waits.
     *
     * Measured in the e2e suite: eight of these in one run, and the socket
     * teardown left every subsequent request on that connection hanging until
     * the test timed out. Ten tests failed in `publish.e2e-spec.ts` with
     * `Exceeded timeout`, cascading 60s → 120s → 90s as each inherited the
     * broken connection — a failure that looked like slowness and was a crash.
     *
     * The log line above still runs, so nothing is hidden: the error is
     * recorded, and the response the client already received stands.
     */
    if (response.headersSent) {
      return;
    }

    const body: ApiErrorResponse = {
      error,
      meta: { requestId, timestamp: new Date().toISOString() },
    };

    response.status(status).json(body);
  }

  /** Map a thrown value to a status, a client-safe error, and a log level. */
  private translate(exception: unknown): {
    status: number;
    error: ApiError;
    logAsError: boolean;
  } {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    /**
     * A body rejected by the parser, before any handler ran.
     *
     * 🔴 **It was a `500`, and that `500` wedged the order queue.** `body-parser`
     * throws a plain `Error` carrying `status`/`statusCode` — **not** a Nest
     * `HttpException` — so the check above missed it and an oversized body fell
     * through to `INTERNAL_ERROR`. `OrderReporter` drops a 4xx as rejected but
     * treats `>= 500` as retryable and `break`s its drain, so one oversized
     * order retried every fifteen minutes for ever **and blocked every order
     * behind it**. Measured before the fix: a 150 kb body answered `500`, and
     * `ReportOrderDto` permits ~148 kb (ADR-072).
     *
     * ⚠️ **Narrow on purpose.** Only a 4xx is translated: these are the
     * caller's mistake, and the status the parser chose is the right one. A
     * 5xx-shaped error from anywhere still reaches the generic handler below,
     * which logs it as ours rather than reporting the caller's request as
     * faulty.
     */
    const parserStatus = this.bodyParserStatus(exception);

    if (parserStatus !== null) {
      return {
        status: parserStatus,
        error: {
          code: this.codeForStatus(parserStatus),
          message:
            parserStatus === HttpStatus.PAYLOAD_TOO_LARGE
              ? 'The request body is too large.'
              : 'The request body could not be read.',
        },
        logAsError: false,
      };
    }

    /**
     * A password the caller chose that cannot be stored safely.
     *
     * `assertUsablePassword()` throws this, and it is the caller's input rather
     * than our fault — so a `400` naming the field, not a `500`.
     *
     * 🔴 **It was a `500`.** The DTO's `@MaxLength(72)` counted characters while
     * bcrypt's limit is 72 **bytes**, so a 60-character emoji passphrase reached
     * this throw and the filter had no case for it. Measured before the fix:
     * `POST /auth/register` answered `INTERNAL_ERROR` for a password a user had
     * every reason to think was fine.
     *
     * `MaxBytes` on the DTO now catches that case first and names the field.
     * This mapping stays as the floor: the check lives in `password.ts` for
     * every caller, including any that never passes through a DTO, and a throw
     * from there must still be a `400`.
     */
    if (exception instanceof WeakPasswordError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request contains invalid fields.',
          details: [
            {
              field: 'password',
              code: 'INVALID',
              /*
               * `params`, not a sentence: `ErrorDetail` carries values for the
               * client to interpolate so the message can be localised. The
               * limits are what a form needs to say something useful.
               */
              params: { maxBytes: MAX_PASSWORD_BYTES, minLength: MIN_PASSWORD_LENGTH },
            },
          ],
        },
        logAsError: false,
      };
    }

    /**
     * A unique-constraint violation is the caller's problem, not ours.
     *
     * Every check-then-insert has a race: two requests both pass the
     * "is this key free?" query and both insert. The constraint closes it, and
     * without this the loser gets a **500 for the same collision that returns
     * 400 when it happens serially** — the caller cannot tell a bug from a
     * retryable conflict.
     *
     * Only the index *name* is used, to name the field. The driver message is
     * still discarded: it quotes the colliding value, which is user data.
     */
    const duplicate = asUniqueViolation(exception);

    if (duplicate) {
      return {
        status: HttpStatus.CONFLICT,
        error: {
          code: ErrorCode.CONFLICT,
          message: 'That value is already in use.',
          details: [duplicate.detail],
        },
        // Not our bug, so no stack trace — but logged at warn with the index, so
        // a constraint colliding constantly is still visible.
        logAsError: false,
      };
    }

    /**
     * A lock conflict is transient, not a fault.
     *
     * Two correct transactions touched the same rows in different orders and
     * MySQL rolled one back. A 500 tells the caller the server is broken; a 409
     * tells them what happened and that a retry will likely succeed.
     */
    if (isTransientLockConflict(exception)) {
      return {
        status: HttpStatus.CONFLICT,
        error: {
          code: ErrorCode.CONFLICT,
          message: 'That resource was being changed by someone else. Please try again.',
        },
        logAsError: false,
      };
    }

    // Any other database error means a bug or an outage, never something the
    // client can fix. The driver message is logged and discarded from the
    // response — it routinely contains SQL and column names.
    if (exception instanceof QueryFailedError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
        },
        logAsError: true,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
      },
      logAsError: true,
    };
  }

  /** Translate a Nest `HttpException`, including our own `DomainException`. */
  private fromHttpException(exception: HttpException): {
    status: number;
    error: ApiError;
    logAsError: boolean;
  } {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const logAsError = status >= HttpStatus.INTERNAL_SERVER_ERROR;

    // A DomainException carries its own code and details.
    if (this.isDomainPayload(payload)) {
      return {
        status,
        error: {
          code: payload.code,
          message: payload.message,
          ...(payload.details ? { details: payload.details } : {}),
        },
        logAsError,
      };
    }

    // The global ValidationPipe throws a BadRequestException whose payload is a
    // string array. Convert it into structured details so the dashboard can
    // render each failure beside its field rather than as one blob of prose.
    if (this.isValidationPayload(payload)) {
      return {
        status,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request contains invalid fields.',
          details: this.toValidationDetails(payload.message),
        },
        logAsError: false,
      };
    }

    return {
      status,
      error: {
        code: this.codeForStatus(status),
        message: exception.message,
      },
      logAsError,
    };
  }

  private isDomainPayload(
    payload: unknown,
  ): payload is { code: ErrorCodeValue; message: string; details?: ErrorDetail[] } {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'code' in payload &&
      typeof (payload as { code: unknown }).code === 'string'
    );
  }

  private isValidationPayload(payload: unknown): payload is { message: string[] } {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      Array.isArray((payload as { message: unknown }).message)
    );
  }

  /**
   * Turn class-validator's `"field - constraint"` strings into structured
   * details.
   *
   * Best-effort: class-validator produces prose, so the field is recovered from
   * the conventional prefix and the rest kept as the message. Domain code
   * should throw `DomainException.validation()` with real details instead.
   */
  /**
   * Turn the ValidationPipe's payload into per-field details.
   *
   * **The field name is the point.** ADR-009 promises structured details so a
   * form can highlight the input at fault; without a field the client can only
   * say "something is wrong", which is the least useful thing an API can tell a
   * user filling in a form.
   *
   * Two shapes arrive here. `main.ts` configures an `exceptionFactory` that
   * emits `{ field, message }` objects, which is the accurate path. Plain
   * strings still occur — a `BadRequestException` thrown by hand, or a pipe
   * configured elsewhere — so they are handled rather than dropped, with the
   * field recovered from the message where class-validator names it first.
   */
  private toValidationDetails(messages: Array<string | ValidationMessage>): ErrorDetail[] {
    return messages.map((raw) => {
      if (typeof raw === 'object' && raw !== null && 'field' in raw) {
        return {
          field: String(raw.field),
          code: 'INVALID',
          params: { message: String(raw.message) },
        };
      }

      const text = String(raw);

      // The historical `field - message` form, still produced by anything that
      // throws a BadRequestException by hand.
      const [head, ...rest] = text.split(' - ');

      if (rest.length > 0) {
        return {
          field: head.trim(),
          code: 'INVALID',
          params: { message: rest.join(' - ').trim() },
        };
      }

      // Otherwise the field is unknown. Guessing from the first word would
      // label "something went wrong" as a field called `something`, which is
      // worse than admitting we do not know — a form would highlight nothing
      // and the message would look like a bug.
      return { field: '', code: 'INVALID', params: { message: text } };
    });
  }

  /**
   * The 4xx a body-parser error carries, or `null` if this is not one.
   *
   * Recognised by **shape**, not by class: `body-parser` does not export its
   * error types, and `instanceof` against a transitive dependency's internals
   * would break on any version that reorganises them. `type` is the parser's
   * own discriminator (`entity.too.large`, `entity.parse.failed`), so its
   * presence alongside a numeric `status` is what distinguishes these from an
   * arbitrary error that happens to carry a `status` field.
   */
  private bodyParserStatus(exception: unknown): number | null {
    if (typeof exception !== 'object' || exception === null) {
      return null;
    }

    const candidate = exception as { status?: unknown; type?: unknown };

    if (typeof candidate.type !== 'string' || typeof candidate.status !== 'number') {
      return null;
    }

    const isClientError = candidate.status >= 400 && candidate.status < 500;

    return isClientError ? candidate.status : null;
  }

  /** Fall back to a code for Nest's built-in exceptions. */
  private codeForStatus(status: number): ErrorCodeValue {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      /*
       * 🔴 **Measured, not anticipated.** With no explicit limit, Express's
       * 100 kb default applied and body-parser's `PayloadTooLargeError` — not a
       * Nest `HttpException` — fell through to `INTERNAL_ERROR`. A 150 kb body
       * answered `500`, and `OrderReporter` treats `>= 500` as retryable and
       * `break`s its drain: **one oversized order blocked the whole queue for
       * ever**. `ReportOrderDto` permits ~148 kb, so it was reachable (ADR-072).
       */
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
