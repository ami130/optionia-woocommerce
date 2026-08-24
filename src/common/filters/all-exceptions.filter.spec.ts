import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';
import type { ApiErrorResponse } from '../http/api-response.types';

/**
 * The filter shapes every error the API will ever return, and enforces one
 * security rule: an unexpected error never leaks detail to the client.
 *
 * A `QueryFailedError` reaching a response body exposes table and column names;
 * a stack trace exposes file paths and library versions. Both must be logged
 * against the request id and discarded from the response.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let status: jest.Mock;
  let json: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();

    // Silence the filter's own logging; assertions are about the response.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);

    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });

    host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
  });

  /** The response body the filter produced. */
  function body(): ApiErrorResponse {
    expect(json).toHaveBeenCalledTimes(1);

    return json.mock.calls[0][0] as ApiErrorResponse;
  }

  describe('never leaks internal detail', () => {
    /**
     * The reason this filter exists. TypeORM puts the failing SQL and the
     * driver's message on the error; both name real tables and columns.
     */
    it('reduces a QueryFailedError to INTERNAL_ERROR with no detail', () => {
      const dbError = new QueryFailedError(
        'SELECT `secret_column` FROM `tenants` WHERE `id` = ?',
        [],
        new Error("Unknown column 'secret_column' in 'field list'"),
      );

      filter.catch(dbError, host);

      const response = body();

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(response.error.message).toBe('An unexpected error occurred.');

      // The specifics: nothing from the query or driver may survive.
      const serialised = JSON.stringify(response);
      expect(serialised).not.toContain('secret_column');
      expect(serialised).not.toContain('tenants');
      expect(serialised).not.toContain('SELECT');
      expect(response.error.details).toBeUndefined();
    });

    it('reduces an unknown throw to INTERNAL_ERROR', () => {
      filter.catch(new Error('ENOENT: /srv/app/src/config/secrets.ts'), host);

      const response = body();

      expect(response.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(JSON.stringify(response)).not.toContain('/srv/app');
    });

    it('handles a thrown non-Error without crashing', () => {
      // `throw 'string'` is legal JavaScript and appears in dependencies.
      filter.catch('a bare string', host);

      expect(body().error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('handles a thrown null', () => {
      filter.catch(null, host);

      expect(body().error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  describe('DomainException', () => {
    it('preserves the code, message and status', () => {
      filter.catch(DomainException.notFound('Option set'), host);

      const response = body();

      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(response.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(response.error.message).toBe('Option set not found.');
    });

    it('preserves structured details', () => {
      filter.catch(
        DomainException.validation([{ field: 'label', code: 'TOO_LONG', params: { max: 60 } }]),
        host,
      );

      const details = body().error.details;

      expect(details).toHaveLength(1);
      expect(details![0]).toEqual({ field: 'label', code: 'TOO_LONG', params: { max: 60 } });
    });

    it('omits details when there are none', () => {
      filter.catch(DomainException.conflict('Already published.'), host);

      expect(body().error).not.toHaveProperty('details');
    });
  });

  describe('Nest built-in exceptions', () => {
    it('maps NotFoundException to NOT_FOUND', () => {
      filter.catch(new NotFoundException('Cannot GET /v1/nope'), host);

      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(body().error.code).toBe(ErrorCode.NOT_FOUND);
    });

    /**
     * The global ValidationPipe throws a BadRequestException whose payload is a
     * string array. Those become structured details so the dashboard can render
     * each failure beside its field rather than as one blob of prose.
     */
    it('converts ValidationPipe messages into structured details', () => {
      filter.catch(
        new BadRequestException({
          message: ['email - must be an email', 'name - should not be empty'],
          statusCode: 400,
        }),
        host,
      );

      const response = body();

      expect(response.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.error.details).toHaveLength(2);
      expect(response.error.details![0].field).toBe('email');
      expect(response.error.details![1].field).toBe('name');
    });

    it('keeps an unsplittable validation message intact', () => {
      filter.catch(new BadRequestException({ message: ['something went wrong'] }), host);

      const detail = body().error.details![0];

      expect(detail.field).toBe('');
      expect(detail.params).toEqual({ message: 'something went wrong' });
    });
  });

  describe('meta', () => {
    it('is present on every error', () => {
      filter.catch(new Error('boom'), host);

      const { meta } = body();

      expect(meta.requestId).toBeDefined();
      expect(() => new Date(meta.timestamp).toISOString()).not.toThrow();
    });
  });

  describe('log levels', () => {
    it('logs 5xx as an error, with the exception attached', () => {
      const spy = jest.spyOn(filter['logger'], 'error');

      filter.catch(new Error('boom'), host);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    /**
     * A 404 is the caller's problem, not our failure. Logging bot traffic at
     * `error` fills the error stream and hides genuine incidents.
     */
    it('logs 4xx as a warning', () => {
      const error = jest.spyOn(filter['logger'], 'error');
      const warn = jest.spyOn(filter['logger'], 'warn');

      filter.catch(DomainException.notFound('Thing'), host);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
