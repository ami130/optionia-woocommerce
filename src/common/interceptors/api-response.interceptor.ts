import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';

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
export class ApiResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<unknown> | T
> {
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
      /*
       * 🔴 **A handler may have answered the request itself.**
       *
       * `config-delivery` writes its own `304` and returns `undefined`, because
       * a 304 must carry no body (RFC 9110 §15.4.5) and the envelope below would
       * otherwise wrap that `undefined` into `{data: null, meta}` — a body the
       * status forbids.
       *
       * Emitting anything here means Nest writes it
       * (`RouterResponseController.apply`) to a response that is already
       * finished, which throws `ERR_HTTP_HEADERS_SENT` inside the router. Before
       * `AllExceptionsFilter` gained a `headersSent` guard that throw destroyed
       * the connection and left clients waiting forever; with it the write is
       * refused, but the error is still raised and logged on every such request.
       *
       * Measured: **one per 304**, exactly — four 304s in the config-delivery
       * suite produced four errors, every run.
       *
       * `filter` rather than a guard inside `map`: the payload must not reach
       * Nest at all, and an empty stream is how an interceptor says "nothing to
       * send".
       */
      filter(() => {
        // Defensive: a non-HTTP context, or a caller that supplies no response,
        // has nothing already sent — so the payload proceeds as normal.
        const response = context.switchToHttp().getResponse?.<{ headersSent?: boolean }>();

        return !response?.headersSent;
      }),
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
