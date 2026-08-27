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

  /**
   * The authenticated user, once a guard has resolved one.
   *
   * Mutable because authentication happens after the context is created: the
   * middleware that opens it runs before any guard, so that a malformed body
   * still gets a correlation id.
   */
  userId?: string;

  /**
   * The tenant this request acts within.
   *
   * Set by `TenantGuard` and read by the scoped repository layer (M6.4). It is
   * deliberately not on the request object: a repository reaching into an HTTP
   * request would tie the data layer to a transport, and a background job would
   * have no way to scope itself.
   */
  tenantId?: string;

  /** The caller's role in that tenant, for the permission matrix (M6.5). */
  tenantRole?: string;

  /**
   * The store acting, when the request authenticated through the store realm.
   *
   * Set by `StoreTokenGuard` and never by a user's token: a merchant's JWT names
   * a person and a tenant, not a store. Present exactly when `realm` is
   * `'store'`, which is what lets a handler tell "this tenant" from "this store
   * within the tenant" without re-reading the credential.
   */
  storeId?: string;

  /**
   * When the access token was issued, in seconds.
   *
   * Compared against the user's `sessionsInvalidatedAt` so a token issued before
   * a logout is rejected before its natural expiry.
   */
  tokenIssuedAt?: number;

  /**
   * Which identity realm authenticated this request.
   *
   * Three realms exist and must never blur: platform staff, tenant members, and
   * store tokens. Recording it here means a guard can refuse a token from the
   * wrong realm without re-parsing it.
   */
  realm?: 'platform' | 'tenant' | 'store';

  /**
   * The caller's IP, as seen at the socket.
   *
   * Captured in middleware rather than read from the request where it is
   * needed, because M7.6 requires it on audit entries and a service reaching
   * into an HTTP request would tie the audit layer to a transport — the same
   * reason `tenantId` lives here.
   *
   * ⚠️ Personal data under GDPR wherever it is persisted (Phase 26b retention).
   */
  ip?: string;

  /** The caller's user agent, truncated to what `audit_logs` stores. */
  userAgent?: string;
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

/**
 * The tenant this request acts within.
 *
 * **Throws when there is none.** That is the entire point: the scoped repository
 * layer calls this on every query, and a version returning `null` would let a
 * missing tenant become an unscoped query — every row in the table, silently,
 * with no error anywhere. A thrown exception is a 500; a silent unscoped read is
 * a cross-tenant data leak.
 *
 * Code that legitimately runs without a tenant — migrations, seeds, platform
 * admin routes — must not call this. It uses `getContext()` and handles the
 * absence explicitly.
 */
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;

  if (!tenantId) {
    throw new Error(
      'No tenant in the request context. A tenant-scoped query cannot run ' +
        'without one — this is a missing TenantGuard, not a condition to handle.',
    );
  }

  return tenantId;
}

/** The current tenant, or null. For code that legitimately may have none. */
export function getTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

/** The authenticated user, or null outside an authenticated request. */
export function getUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/**
 * The store acting, or null.
 *
 * Null for every tenant- and platform-realm request, which is the normal case —
 * so callers branch on it rather than treating absence as an error.
 */
export function getStoreId(): string | null {
  return storage.getStore()?.storeId ?? null;
}

/**
 * The caller's IP, or null.
 *
 * Null outside a request and null when the address could not be determined —
 * both are legitimate, so callers record the absence rather than inventing a
 * value.
 */
export function getClientIp(): string | null {
  return storage.getStore()?.ip ?? null;
}

/** The caller's user agent, or null. */
export function getUserAgent(): string | null {
  return storage.getStore()?.userAgent ?? null;
}
