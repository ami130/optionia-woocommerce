import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { getRequestId } from '../context/request-context';
import {
  type ApiSuccessResponse,
  PaginatedResult,
  type ResponseMeta,
} from '../http/api-response.types';

/**
 * Wraps every successful response in the envelope. See ADR-009.
 *
 * Controllers return domain objects and never construct a response shape, so
 * the envelope cannot drift between endpoints.
 */
@Injectable()
export class ApiResponseInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<unknown> | T>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown> | T> {
    // Probe endpoints are consumed by load balancers and monitoring that expect
    // a flat body. Wrapping them would break those consumers for no benefit, so
    // the exclusion is enforced here rather than merely documented.
    if (ApiResponseInterceptor.isUnwrapped(context)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload) => {
        const meta: ResponseMeta = {
          requestId: getRequestId(),
          timestamp: new Date().toISOString(),
        };

        // A controller returning PaginatedResult has its cursor lifted into
        // meta, leaving `data` a clean array. Clients therefore never special-
        // case list endpoints.
        if (payload instanceof PaginatedResult) {
          return {
            data: payload.items,
            meta: { ...meta, pagination: payload.pagination },
          };
        }

        // `undefined` (a 204-style handler) becomes null rather than omitting
        // the key, so `data` is always present and clients need no existence
        // check before reading it.
        return { data: payload ?? null, meta };
      }),
    );
  }

  /** Paths returned unwrapped. Matched on the full request path. */
  static readonly UNWRAPPED_ROUTES = ['/health'];

  /** Whether this request targets a route that must not be wrapped. */
  private static isUnwrapped(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return false;
    }

    const path = context.switchToHttp().getRequest<{ path?: string }>().path ?? '';

    return ApiResponseInterceptor.UNWRAPPED_ROUTES.some(
      (route) => path === route || path.startsWith(`${route}/`),
    );
  }
}
