import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { ApiResponseInterceptor } from './api-response.interceptor';
import { PaginatedResult, type ApiSuccessResponse } from '../http/api-response.types';

/**
 * The interceptor shapes every successful response the API returns (ADR-009).
 *
 * Two behaviours matter beyond the happy path: `/health` must NOT be wrapped,
 * because load balancers expect a flat body; and `PaginatedResult` must lift
 * its cursor into `meta`, so clients never special-case list endpoints.
 */
describe('ApiResponseInterceptor', () => {
  const interceptor = new ApiResponseInterceptor();

  /** A context for the given request path. */
  function contextFor(path: string, type: 'http' | 'rpc' = 'http'): ExecutionContext {
    return {
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => ({ path }) }),
    } as unknown as ExecutionContext;
  }

  function handlerReturning(payload: unknown): CallHandler {
    return { handle: () => of(payload) } as CallHandler;
  }

  async function run(path: string, payload: unknown): Promise<unknown> {
    return firstValueFrom(
      interceptor.intercept(contextFor(path), handlerReturning(payload)) as never,
    );
  }

  describe('wrapping', () => {
    it('wraps a resource in data plus meta', async () => {
      const result = (await run('/v1/option-sets/1', {
        id: 'abc',
        name: 'Engraving',
      })) as ApiSuccessResponse<{ id: string }>;

      expect(result.data).toEqual({ id: 'abc', name: 'Engraving' });
      expect(result.meta.requestId).toBeDefined();
      expect(() => new Date(result.meta.timestamp).toISOString()).not.toThrow();
    });

    it('wraps an array without treating it as paginated', async () => {
      const result = (await run('/v1/things', [1, 2, 3])) as ApiSuccessResponse<number[]>;

      expect(result.data).toEqual([1, 2, 3]);
      expect(result.meta.pagination).toBeUndefined();
    });

    /**
     * `data` is always present, so clients never need an existence check before
     * reading it. A 204-style handler returning undefined becomes null rather
     * than omitting the key.
     */
    it('normalises undefined to null', async () => {
      const result = (await run('/v1/things', undefined)) as ApiSuccessResponse<null>;

      expect(result).toHaveProperty('data');
      expect(result.data).toBeNull();
    });

    it('preserves an explicit null', async () => {
      const result = (await run('/v1/things', null)) as ApiSuccessResponse<null>;

      expect(result.data).toBeNull();
    });

    it('preserves falsy values that are not nullish', async () => {
      expect(((await run('/v1/x', 0)) as ApiSuccessResponse<number>).data).toBe(0);
      expect(((await run('/v1/x', false)) as ApiSuccessResponse<boolean>).data).toBe(false);
      expect(((await run('/v1/x', '')) as ApiSuccessResponse<string>).data).toBe('');
    });
  });

  describe('pagination', () => {
    it('lifts the cursor into meta and leaves data a clean array', async () => {
      const paginated = new PaginatedResult([{ id: 'a' }, { id: 'b' }], {
        cursor: 'next-page-token',
        hasMore: true,
        limit: 50,
      });

      const result = (await run('/v1/products', paginated)) as ApiSuccessResponse<
        { id: string }[]
      >;

      expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(result.meta.pagination).toEqual({
        cursor: 'next-page-token',
        hasMore: true,
        limit: 50,
      });
    });

    it('handles an empty final page', async () => {
      const paginated = new PaginatedResult([], { cursor: null, hasMore: false, limit: 50 });

      const result = (await run('/v1/products', paginated)) as ApiSuccessResponse<unknown[]>;

      expect(result.data).toEqual([]);
      expect(result.meta.pagination!.hasMore).toBe(false);
      expect(result.meta.pagination!.cursor).toBeNull();
    });
  });

  describe('unwrapped routes', () => {
    /**
     * Load balancers and monitoring consume `/health` and expect Terminus's flat
     * body. Wrapping it would break them for no benefit.
     */
    it('leaves /health unwrapped', async () => {
      const payload = { status: 'ok', info: { database: { status: 'up' } } };

      const result = await run('/health', payload);

      expect(result).toBe(payload);
      expect(result).not.toHaveProperty('meta');
    });

    it('leaves nested health paths unwrapped', async () => {
      const payload = { status: 'ok' };

      expect(await run('/health/readiness', payload)).toBe(payload);
    });

    it('still wraps a path that merely starts with the same letters', async () => {
      // `/healthcheck` is not `/health` — prefix matching must respect the
      // boundary, or an unrelated future route silently loses its envelope.
      const result = (await run('/v1/healthcheck-settings', {
        id: 'x',
      })) as ApiSuccessResponse<{ id: string }>;

      expect(result).toHaveProperty('meta');
      expect(result.data).toEqual({ id: 'x' });
    });
  });

  describe('non-HTTP contexts', () => {
    it('wraps when the context is not HTTP', async () => {
      // There is no request path outside HTTP, so the exclusion cannot apply
      // and the payload must still be enveloped rather than silently passed
      // through.
      const result = (await firstValueFrom(
        interceptor.intercept(
          contextFor('', 'rpc'),
          handlerReturning({ id: 'x' }),
        ) as never,
      )) as ApiSuccessResponse<{ id: string }>;

      expect(result).toHaveProperty('meta');
      expect(result.data).toEqual({ id: 'x' });
    });
  });
});
