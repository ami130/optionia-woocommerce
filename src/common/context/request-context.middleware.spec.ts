import type { NextFunction, Request, Response } from 'express';

import { getContext, getRequestId } from './request-context';
import { REQUEST_ID_HEADER, RequestContextMiddleware } from './request-context.middleware';

/**
 * The correlation id is the one value tying a merchant's support ticket to a
 * server log line, so it must exist on every request — including the ones that
 * fail early.
 */
describe('RequestContextMiddleware', () => {
  const middleware = new RequestContextMiddleware();

  function run(headers: Record<string, string | string[]> = {}): {
    setHeader: jest.Mock;
    capturedId: string;
  } {
    const setHeader = jest.fn();
    let capturedId = '';

    const req = { headers } as unknown as Request;
    const res = { setHeader } as unknown as Response;
    const next: NextFunction = () => {
      capturedId = getRequestId();
    };

    middleware.use(req, res, next);

    return { setHeader, capturedId };
  }

  it('generates an id when the caller sends none', () => {
    const { capturedId } = run();

    expect(capturedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a different id per request', () => {
    expect(run().capturedId).not.toBe(run().capturedId);
  });

  it('sets the response header', () => {
    const { setHeader, capturedId } = run();

    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, capturedId);
  });

  it('accepts a well-formed id from the caller', () => {
    const supplied = '01234567-89ab-cdef-0123-456789abcdef';

    expect(run({ [REQUEST_ID_HEADER]: supplied }).capturedId).toBe(supplied);
  });

  describe('rejects untrusted input', () => {
    /**
     * Echoing an arbitrary client string into structured logs is a log-injection
     * and log-forging vector: a caller could emit newlines to fake log entries,
     * or claim an id belonging to another tenant's request.
     */
    it.each([
      ['not-a-uuid', 'arbitrary text'],
      ['', 'empty string'],
      ['../../etc/passwd', 'path traversal'],
      ['line1\nline2', 'newline injection'],
      ['<script>alert(1)</script>', 'markup'],
      ['01234567-89ab-cdef-0123-456789abcdeZ', 'almost a uuid'],
    ])('replaces %s (%s)', (candidate) => {
      const { capturedId } = run({ [REQUEST_ID_HEADER]: candidate });

      expect(capturedId).not.toBe(candidate);
      expect(capturedId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('takes the first value when the header is repeated', () => {
      const first = '01234567-89ab-cdef-0123-456789abcdef';

      expect(run({ [REQUEST_ID_HEADER]: [first, 'second'] }).capturedId).toBe(first);
    });
  });

  it('exposes the start time for duration logging', () => {
    let context: ReturnType<typeof getContext> = null;

    const req = { headers: {} } as unknown as Request;
    const res = { setHeader: jest.fn() } as unknown as Response;

    middleware.use(req, res, () => {
      context = getContext();
    });

    expect(context).not.toBeNull();
    expect(typeof context!.startedAt).toBe('number');
  });

  it('reports a sentinel outside a request', () => {
    // Migrations, seeds and CLI commands legitimately run without a request, so
    // this must not throw.
    expect(getRequestId()).toBe('no-request-context');
    expect(getContext()).toBeNull();
  });
});
