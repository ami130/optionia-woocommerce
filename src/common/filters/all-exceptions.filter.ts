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
import { ErrorCode, type ErrorCodeValue } from '../errors/error-codes';
import type { ApiError, ApiErrorResponse, ErrorDetail } from '../http/api-response.types';

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

    // A database error means a bug or an outage, never something the client can
    // fix. The driver message is logged and discarded from the response — it
    // routinely contains SQL and column names.
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
  private toValidationDetails(messages: string[]): ErrorDetail[] {
    return messages.map((raw) => {
      const [field, ...rest] = raw.split(' - ');

      return rest.length > 0
        ? { field: field.trim(), code: 'INVALID', params: { message: rest.join(' - ').trim() } }
        : { field: '', code: 'INVALID', params: { message: raw } };
    });
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
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
