import { describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '../api/error';
import { applyApiErrors, formLevelMessage } from './api-errors';

interface LoginForm extends Record<string, unknown> {
  email: string;
  password: string;
}

const validation = (details: Array<{ field: string; code: string; params?: Record<string, unknown> }>) =>
  new ApiError(400, { code: 'VALIDATION_FAILED', message: 'The request contains invalid fields.', details });

describe('applyApiErrors', () => {
  it('places a field error on the matching input', () => {
    const setError = vi.fn();

    const placed = applyApiErrors<LoginForm>(
      validation([{ field: 'email', code: 'INVALID' }]),
      setError,
      ['email', 'password'],
    );

    expect(placed).toBe(true);
    expect(setError).toHaveBeenCalledWith('email', {
      type: 'server',
      message: 'This is not valid.',
    });
  });

  /**
   * 🔴 **The dotted path is the whole reason no translation layer exists.**
   *
   * The API sends `groups.0.label`; React Hook Form addresses nested fields with
   * exactly that syntax. Asserted rather than assumed, so a change on either
   * side surfaces here instead of as an error attached to nothing.
   */
  it('passes a nested dotted path through unchanged', () => {
    const setError = vi.fn();

    applyApiErrors(
      validation([{ field: 'groups.0.label', code: 'TOO_LONG' }]),
      setError,
      ['groups.0.label'] as never,
    );

    expect(setError).toHaveBeenCalledWith('groups.0.label', {
      type: 'server',
      message: 'This is too long.',
    });
  });

  /**
   * A message on a field the form does not render is a message nobody sees —
   * and the form stays invalid with no visible cause.
   */
  it('reports when a detail names a field the form does not have', () => {
    const setError = vi.fn();

    const placed = applyApiErrors<LoginForm>(
      validation([{ field: 'somethingElse', code: 'INVALID' }]),
      setError,
      ['email', 'password'],
    );

    expect(placed).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('places what it can and still reports the rest', () => {
    const setError = vi.fn();

    const placed = applyApiErrors<LoginForm>(
      validation([
        { field: 'email', code: 'REQUIRED' },
        { field: 'ghost', code: 'INVALID' },
      ]),
      setError,
      ['email', 'password'],
    );

    expect(placed).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
  });

  it('falls back to the API message for an unknown code', () => {
    const setError = vi.fn();

    applyApiErrors<LoginForm>(
      validation([
        { field: 'email', code: 'WEIRD_NEW_CODE', params: { message: 'Try something else.' } },
      ]),
      setError,
      ['email'],
    );

    expect(setError).toHaveBeenCalledWith('email', {
      type: 'server',
      message: 'Try something else.',
    });
  });

  /**
   * 🔴 **The sentence is at `params.message`, not at a top-level `message`.**
   *
   * Verified against the live API: `toValidationDetails()` keeps details
   * structured so a client can localise them, and puts class-validator's text
   * inside `params`. This type originally declared a top-level `message` that
   * the API never populates — every field error would have silently shown
   * generic fallback copy instead of the reason.
   *
   * The fixture below is a real response body, copied verbatim.
   */
  it('reads the API’s own wording from params.message', () => {
    const setError = vi.fn();

    applyApiErrors<LoginForm>(
      new ApiError(400, {
        code: 'VALIDATION_FAILED',
        message: 'The request contains invalid fields.',
        details: [
          {
            field: 'password',
            code: 'INVALID',
            params: {
              message:
                'password must be at most 72 bytes (120 given). Some characters, such as emoji, use several bytes each.',
            },
          },
        ],
      }),
      setError,
      ['password'],
    );

    expect(setError).toHaveBeenCalledWith('password', {
      type: 'server',
      message: expect.stringContaining('72 bytes'),
    });
  });

  it('ignores an error that is not a validation failure', () => {
    const setError = vi.fn();

    const placed = applyApiErrors<LoginForm>(
      new ApiError(403, { code: 'INSUFFICIENT_ROLE', message: 'no' }),
      setError,
      ['email'],
    );

    expect(placed).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });
});

describe('formLevelMessage', () => {
  it('says nothing for a field-level failure', () => {
    expect(formLevelMessage(validation([{ field: 'email', code: 'INVALID' }]))).toBeNull();
  });

  it.each([
    ['UNAUTHENTICATED', 'Your session has ended. Sign in again.'],
    ['INSUFFICIENT_ROLE', 'You do not have permission to do that.'],
    ['RATE_LIMITED', 'Too many attempts. Wait a moment and try again.'],
  ])('has plain copy for %s', (code, expected) => {
    expect(formLevelMessage(new ApiError(403, { code, message: 'raw' }))).toBe(expected);
  });

  /** A retry button belongs on this and not on a 400. */
  it('distinguishes an unreachable server', () => {
    expect(formLevelMessage(new NetworkError())).toContain('Could not reach the server');
  });

  it('falls back to the API message for an unmapped code', () => {
    expect(formLevelMessage(new ApiError(409, { code: 'CONFLICT', message: 'Already published.' })))
      .toBe('Already published.');
  });

  it('has something to say about an unknown throwable', () => {
    expect(formLevelMessage(new Error('boom'))).toBe('Something went wrong.');
  });
});
