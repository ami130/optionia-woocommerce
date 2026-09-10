import { describe, expect, it } from 'vitest';

import {
  AUTH_LIMITS,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth';

const VALID_PASSWORD = 'a-sufficiently-long-password';

describe('auth schemas', () => {
  /**
   * These bounds are the API's, copied. Stating them here means a drift becomes
   * a failing test rather than a form that accepts what the server refuses.
   */
  it('mirrors the API’s documented limits', () => {
    expect(AUTH_LIMITS).toEqual({
      MIN_PASSWORD_LENGTH: 12,
      MAX_PASSWORD_BYTES: 72,
      MAX_EMAIL_LENGTH: 320,
      MIN_TOKEN_LENGTH: 20,
      MAX_TOKEN_LENGTH: 200,
    });
  });

  describe('register', () => {
    const valid = {
      name: 'Sam',
      email: 'sam@example.com',
      password: VALID_PASSWORD,
      tenantName: 'Acme',
    };

    it('accepts a complete registration', () => {
      expect(registerSchema.safeParse(valid).success).toBe(true);
    });

    it.each([
      ['a missing name', { name: '' }],
      ['a malformed email', { email: 'not-an-email' }],
      ['a short password', { password: 'short' }],
      ['a missing workspace name', { tenantName: '' }],
    ])('rejects %s', (_label, override) => {
      expect(registerSchema.safeParse({ ...valid, ...override }).success).toBe(false);
    });

    /**
     * 🔴 **The emoji case, measured against the live API before this existed.**
     *
     * bcrypt truncates at 72 **bytes** and an emoji is four of them: 60 emoji
     * are 60 characters and 120 bytes. A character-length rule lets it through,
     * and the API answered `500` until `MaxBytes` was added to its DTO.
     */
    it('rejects a password that is short in characters but long in bytes', () => {
      const emoji = '🎁'.repeat(30);

      expect(emoji.length).toBeLessThan(AUTH_LIMITS.MAX_PASSWORD_BYTES);
      expect(new TextEncoder().encode(emoji).length).toBeGreaterThan(AUTH_LIMITS.MAX_PASSWORD_BYTES);
      expect(registerSchema.safeParse({ ...valid, password: emoji }).success).toBe(false);
    });

    it('accepts a multibyte password that fits in the byte budget', () => {
      // 12 emoji = 48 bytes, comfortably under 72 and over the 12-char minimum.
      const emoji = '🎁'.repeat(12);

      expect(registerSchema.safeParse({ ...valid, password: emoji }).success).toBe(true);
    });

    it('names the field that failed', () => {
      const result = registerSchema.safeParse({ ...valid, email: 'nope' });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['email']);
    });
  });

  describe('login', () => {
    /**
     * Sign-in checks only that a password was typed.
     *
     * A length rule here tells someone whose password predates the current
     * policy that their own password is invalid — when it works.
     */
    it('accepts a password that would fail the register rules', () => {
      expect(loginSchema.safeParse({ email: 'sam@example.com', password: 'old' }).success).toBe(true);
    });

    it('still requires one', () => {
      expect(loginSchema.safeParse({ email: 'sam@example.com', password: '' }).success).toBe(false);
    });
  });

  describe('forgot password', () => {
    it('accepts an address', () => {
      expect(forgotPasswordSchema.safeParse({ email: 'sam@example.com' }).success).toBe(true);
    });

    it('rejects a malformed one', () => {
      expect(forgotPasswordSchema.safeParse({ email: 'nope' }).success).toBe(false);
    });
  });

  describe('reset password', () => {
    const token = 'a'.repeat(43);

    it('accepts a matching pair', () => {
      const result = resetPasswordSchema.safeParse({
        token,
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.success).toBe(true);
    });

    /** Reported on the field the user must change, not on the form. */
    it('reports a mismatch on the confirmation field', () => {
      const result = resetPasswordSchema.safeParse({
        token,
        password: VALID_PASSWORD,
        confirmPassword: 'something-else-entirely',
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['confirmPassword']);
    });

    it('rejects a token too short to be one', () => {
      const result = resetPasswordSchema.safeParse({
        token: 'short',
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.success).toBe(false);
    });
  });
});
