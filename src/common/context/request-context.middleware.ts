import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

import { runWithContext } from './request-context';

/** Header carrying the correlation id, both inbound and outbound. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Establishes the per-request correlation id.
 *
 * **The API generates the id; it does not require the caller to supply one.**
 *
 * Verified during Phase 5 analysis: the WooCommerce plugin's `Api\Client`
 * *reads* `x-request-id` from responses (`Client.php`, the `$wanted` header
 * list) but never *sends* one. A design that expected an inbound id would
 * therefore produce nothing traceable for the client that most needs it.
 *
 * An inbound id is accepted only when it looks like one we issued. Echoing an
 * arbitrary client string into structured logs is a log-injection and
 * log-forging vector — a caller could emit newlines or fake ids belonging to
 * another tenant's request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  /** Accept only a UUID. Anything else is replaced with a generated id. */
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Matches `audit_logs.user_agent`, so a long header cannot fail a write. */
  private static readonly USER_AGENT_MAX_LENGTH = 500;

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = RequestContextMiddleware.resolveRequestId(req);

    // Set before handing off, so the id is present even if the request fails
    // in a way that bypasses the response interceptor.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext(
      {
        requestId,
        startedAt: Date.now(),
        ip: req.ip,
        userAgent: RequestContextMiddleware.resolveUserAgent(req),
      },
      () => next(),
    );
  }

  /**
   * Use the caller's id when it is a well-formed UUID, otherwise generate one.
   *
   * UUIDv7 rather than v4: it is time-ordered, so ids sort chronologically in a
   * log aggregator without a separate timestamp index.
   */
  /**
   * The caller's user agent, truncated to the column's width.
   *
   * A user agent is caller-controlled text going into a log, so it is bounded
   * here rather than at the database, where an oversized value would either
   * throw mid-audit or be silently cut depending on SQL mode.
   */
  private static resolveUserAgent(req: Request): string | undefined {
    const supplied = req.headers['user-agent'];

    return typeof supplied === 'string' && supplied.length > 0
      ? supplied.slice(0, RequestContextMiddleware.USER_AGENT_MAX_LENGTH)
      : undefined;
  }

  private static resolveRequestId(req: Request): string {
    const supplied = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    if (typeof candidate === 'string' && RequestContextMiddleware.UUID_PATTERN.test(candidate)) {
      return candidate;
    }

    return uuidv7();
  }
}
