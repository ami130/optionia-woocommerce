import { z } from 'zod';

/**
 * The API's validation rules, mirrored.
 *
 * Client-side validation is a **convenience**, never the enforcement: the server
 * checks everything again, and a merchant who bypasses these gets the same
 * refusal in a slower way. What it buys is telling them before a round trip.
 *
 * Every bound below is copied from `optioniaWooCommerceBackend`'s
 * `auth.dto.ts`, and `auth.test.ts` states each one so a drift shows up as a
 * failing test rather than as a form that accepts what the API refuses.
 */

/** `MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_BYTES` in `common/crypto/password.ts`. */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;

/** `@MaxLength(320)` on every email field. */
const MAX_EMAIL_LENGTH = 320;

/** `@MinLength(20) @MaxLength(200)` on every token field. */
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 200;

/**
 * Bytes, not characters.
 *
 * bcrypt truncates at 72 **bytes** and an emoji is four of them, so a
 * 60-character emoji passphrase is 120 bytes. Checking length here would let it
 * through to a server error the form cannot attach to a field — which is exactly
 * what happened before `MaxBytes` was added to the API's DTO.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

const email = z
  .string()
  .min(1, 'Enter your email address.')
  .max(MAX_EMAIL_LENGTH, 'That email address is too long.')
  .email('Enter a valid email address.');

const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .refine(
    (value) => byteLength(value) <= MAX_PASSWORD_BYTES,
    `That password is too long. Some characters, such as emoji, count as several.`,
  );

const token = z
  .string()
  .min(MIN_TOKEN_LENGTH, 'That link is not valid.')
  .max(MAX_TOKEN_LENGTH, 'That link is not valid.');

export const registerSchema = z.object({
  name: z.string().min(1, 'Enter your name.').max(255, 'That name is too long.'),
  email,
  password,
  /**
   * Optional in the API, and asked for here.
   *
   * Registration provisions a tenant, and a workspace named after whoever
   * happened to sign up reads oddly to the second person invited. Asking costs
   * one field.
   */
  tenantName: z.string().min(1, 'Enter a name for your workspace.').max(255, 'That name is too long.'),
});

export const loginSchema = z.object({
  email,
  /**
   * Only "required" here.
   *
   * A length rule on sign-in tells someone whose password predates the current
   * policy that their own password is invalid, when the real answer is that it
   * works. The server decides.
   */
  password: z.string().min(1, 'Enter your password.'),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    token,
    password,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Those passwords do not match.',
    // Reported on the field the user must change, not on the form.
    path: ['confirmPassword'],
  });

export const resendVerificationSchema = z.object({ email });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export const AUTH_LIMITS = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  MAX_EMAIL_LENGTH,
  MIN_TOKEN_LENGTH,
  MAX_TOKEN_LENGTH,
} as const;
