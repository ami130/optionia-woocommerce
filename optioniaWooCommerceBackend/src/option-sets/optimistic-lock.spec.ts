import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { assertVersionMatches } from './optimistic-lock';

describe('assertVersionMatches', () => {
  it('accepts a matching version', () => {
    expect(() => assertVersionMatches(4, 4)).not.toThrow();
  });

  /** Scripts and jobs legitimately have no loaded version. */
  it('accepts an absent expectation', () => {
    expect(() => assertVersionMatches(4, undefined)).not.toThrow();
  });

  it('refuses a stale version', () => {
    expect(() => assertVersionMatches(5, 4)).toThrow(DomainException);
  });

  /** A version from the future is as wrong as one from the past. */
  it('refuses a version ahead of the server', () => {
    expect(() => assertVersionMatches(4, 5)).toThrow(DomainException);
  });

  it('answers with VERSION_MISMATCH, which is a 409', () => {
    try {
      assertVersionMatches(5, 4);
      throw new Error('should have thrown');
    } catch (error) {
      const domain = error as DomainException;

      expect(domain.code).toBe(ErrorCode.VERSION_MISMATCH);
      expect(domain.getStatus()).toBe(409);
    }
  });

  /**
   * The 409 must carry the current version, or the dashboard has nothing to
   * offer but an error toast — M7.4b asks for a real choice.
   */
  it('carries the current version so a client can act on it', () => {
    try {
      assertVersionMatches(9, 4);
      throw new Error('should have thrown');
    } catch (error) {
      const details = (error as DomainException).details;

      expect(details).toEqual([{ field: 'rowVersion', code: 'STALE', params: { current: 9 } }]);
    }
  });

  it('treats zero as a real version rather than absent', () => {
    expect(() => assertVersionMatches(1, 0)).toThrow(DomainException);
    expect(() => assertVersionMatches(0, 0)).not.toThrow();
  });
});
