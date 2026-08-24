import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request state, available anywhere without threading it through every
 * function signature.
 *
 * Backed by `AsyncLocalStorage`, so it survives `await` boundaries and stays
 * isolated between concurrent requests.
 *
 * Phase 6 adds the tenant to this store, which is what makes the scoped
 * repository layer (M6.4) possible: a query with no tenant in context throws
 * rather than silently returning unscoped rows.
 */
export interface RequestContext {
  /** Correlation id for this request. Always present. */
  readonly requestId: string;

  /** When the request started, for duration logging. */
  readonly startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run a callback with the given context bound to it. */
export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/**
 * The current context, or null outside a request.
 *
 * Null is a legitimate state — migrations, seeds and CLI commands all run
 * without one — so callers must handle it rather than assuming a request.
 */
export function getContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/**
 * The current request id, or `'no-request-context'` outside a request.
 *
 * Returns a sentinel rather than throwing: this is called from the logger and
 * the response interceptor, and neither should fail because it ran outside a
 * request.
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request-context';
}
