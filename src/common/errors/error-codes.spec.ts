import { HttpStatus } from '@nestjs/common';

import { DomainException } from './domain.exception';
import { ERROR_STATUS, ErrorCode } from './error-codes';

/**
 * Error codes are a public contract (ADR-010). Clients branch on them, so
 * changing one is a breaking API change — these tests exist to make that
 * deliberate rather than accidental.
 */
describe('error codes', () => {
  it('maps every code to a status', () => {
    const codes = Object.values(ErrorCode);
    const mapped = Object.keys(ERROR_STATUS);

    expect(mapped.sort()).toEqual([...codes].sort());
  });

  it('groups codes onto the correct status', () => {
    expect(ERROR_STATUS[ErrorCode.VALIDATION_FAILED]).toBe(HttpStatus.BAD_REQUEST);
    expect(ERROR_STATUS[ErrorCode.UNAUTHENTICATED]).toBe(HttpStatus.UNAUTHORIZED);
    expect(ERROR_STATUS[ErrorCode.FORBIDDEN]).toBe(HttpStatus.FORBIDDEN);
    expect(ERROR_STATUS[ErrorCode.NOT_FOUND]).toBe(HttpStatus.NOT_FOUND);
    expect(ERROR_STATUS[ErrorCode.VERSION_MISMATCH]).toBe(HttpStatus.CONFLICT);
    expect(ERROR_STATUS[ErrorCode.RATE_LIMITED]).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(ERROR_STATUS[ErrorCode.INTERNAL_ERROR]).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('uses SCREAMING_SNAKE_CASE throughout', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('DomainException', () => {
  it('derives the status from the code', () => {
    const exception = new DomainException(ErrorCode.NOT_FOUND, 'Gone.');

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('carries structured details', () => {
    const exception = DomainException.validation([
      { field: 'label', code: 'TOO_LONG', params: { max: 60 } },
    ]);

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.details).toHaveLength(1);
    expect(exception.details![0].params).toEqual({ max: 60 });
  });

  /**
   * The security-relevant one.
   *
   * Returning FORBIDDEN for a cross-tenant access attempt confirms the resource
   * exists, turning an authorization boundary into an enumeration oracle: an
   * attacker walks ids and learns which belong to other tenants from the status
   * code alone. From outside the tenant, the resource does not exist.
   */
  it('reports a missing resource as NOT_FOUND, not FORBIDDEN', () => {
    const exception = DomainException.notFound('Option set');

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.code).toBe(ErrorCode.NOT_FOUND);
    expect(exception.code).not.toBe(ErrorCode.FORBIDDEN);
  });

  it('distinguishes a stale version from a plain conflict', () => {
    // The client can act on a version mismatch — reload, diff, let the user
    // choose — so it must be distinguishable from any other 409.
    const stale = DomainException.versionMismatch('Someone else saved first.');
    const plain = DomainException.conflict('Already published.');

    expect(stale.getStatus()).toBe(plain.getStatus());
    expect(stale.code).not.toBe(plain.code);
  });

  it('defaults forbidden and unauthenticated messages', () => {
    expect(DomainException.forbidden().message).toMatch(/not permitted/i);
    expect(DomainException.unauthenticated().message).toMatch(/authentication/i);
  });
});
