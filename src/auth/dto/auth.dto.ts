import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '../../common/crypto/password';

/**
 * Request shapes for the auth endpoints.
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so a body carrying an unexpected field is rejected outright rather than having
 * it silently dropped — which is what stops a caller from probing for fields the
 * API might accept.
 *
 * **Length limits are on every string.** Without them a multi-megabyte `name`
 * reaches bcrypt and the database, and the cheapest denial of service available
 * is a large JSON body.
 */

export class RegisterDto {
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email: string;

  /**
   * The maximum is not cosmetic: bcrypt silently truncates at 72 bytes, so a
   * longer value would be weaker than the user believes.
   */
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  })
  @MaxLength(MAX_PASSWORD_BYTES)
  password: string;

  @IsString()
  @MaxLength(255)
  name: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email: string;

  /**
   * Deliberately not length-validated beyond a ceiling. Rejecting a short
   * password at login would tell a caller the stored one is longer, and the
   * answer to a wrong password is the same either way.
   */
  @IsString()
  @MaxLength(MAX_PASSWORD_BYTES)
  password: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}

export class ResendVerificationDto {
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email: string;
}

export class RequestPasswordResetDto {
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  })
  @MaxLength(MAX_PASSWORD_BYTES)
  password: string;
}

export class RefreshDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}
