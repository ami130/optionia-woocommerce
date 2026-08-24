import { Body, Controller, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import {
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';

/**
 * The auth endpoints.
 *
 * **Every response here is designed so it cannot answer "does this account
 * exist?"** That is why register, resend and password-reset all return the same
 * body regardless of what happened, and why login gives one message for both a
 * wrong password and an unknown address.
 *
 * Rate limits are per endpoint and far tighter than the global 20/second and
 * 300/minute, which are sane API limits and useless here — 300 login attempts a
 * minute is a credential-stuffing surface, not a rate limit.
 */
@Controller('auth')
@UseGuards(AuthThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Register.
   *
   * 5 an hour per address. Registration is expensive — a bcrypt hash and an
   * email — and nobody legitimately registers the same address repeatedly.
   */
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  async register(@Body() dto: RegisterDto): Promise<{ message: string }> {
    await this.auth.register(dto.email, dto.password, dto.name, dto.tenantName ?? '');

    // 202, not 201: whether a user was created is exactly what this endpoint
    // must not disclose. The wording is true either way.
    return {
      message: 'If that address can be registered, a verification email is on its way.',
    };
  }

  /**
   * Verify an email address.
   *
   * 10 an hour. A legitimate merchant clicks once; a higher rate is someone
   * guessing tokens, and a 32-byte token is not guessable at any rate — the limit
   * exists to stop the attempt costing us database reads.
   */
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ verified: boolean }> {
    const verified = await this.auth.verifyEmail(dto.token);

    if (!verified) {
      // One message for expired, already-used and never-existed. Distinguishing
      // them confirms a token was once valid.
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That verification link is no longer valid. Request a new one.',
      );
    }

    return { verified: true };
  }

  /**
   * Resend a verification email.
   *
   * 3 an hour per address — this is the email-bombing vector M6.1 names. Without
   * a tight limit anyone can point it at a stranger's inbox.
   */
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    await this.auth.resendVerification(dto.email);

    return { message: 'If that address needs verifying, a new email is on its way.' };
  }

  /**
   * Log in.
   *
   * 10 in 15 minutes for one address from one origin. Enough for a person who
   * genuinely cannot remember which password they used; nowhere near enough to
   * work through a list.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
  ): Promise<{ userId: string; emailVerified: boolean; refreshToken: string }> {
    const user = await this.auth.validateCredentials(dto.email, dto.password);

    if (!user) {
      // Deliberately identical for a wrong password and an address that has never
      // registered. Anything more specific is a membership oracle.
      throw new DomainException(
        ErrorCode.UNAUTHENTICATED,
        'Email or password is incorrect.',
      );
    }

    if (user.emailVerifiedAt === null) {
      // Safe to distinguish: the caller has already proven they hold the
      // password, so this tells them nothing they did not know.
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'Verify your email address before signing in.',
      );
    }

    // The user agent is not read here: 6g adds the request context that carries
    // it, and reading the raw header in a controller would be a second source of
    // truth for the same value.
    const refreshToken = await this.sessions.issue(user.id, ip, '');

    return { userId: user.id, emailVerified: true, refreshToken };
  }

  /**
   * Exchange a refresh token for a new one.
   *
   * Every failure returns the same 401. Distinguishing "reused" from "expired"
   * would tell an attacker holding a stolen token that it was once valid and that
   * their replay was noticed — which is exactly what they would want to know.
   *
   * The reuse case is not silent internally: it revokes the whole family and logs
   * a warning, so the signal reaches operations rather than the attacker.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  async refresh(
    @Body() dto: RefreshDto,
    @Ip() ip: string,
  ): Promise<{ refreshToken: string }> {
    const outcome = await this.sessions.rotate(dto.refreshToken ?? '', ip, '');

    if (outcome.failure !== null || outcome.token === null) {
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That session is no longer valid. Sign in again.',
      );
    }

    return { refreshToken: outcome.token };
  }

  /**
   * End a session.
   *
   * Returns 204 whether or not the token was live, for the same reason the other
   * endpoints are uniform: a different answer for an unknown token confirms which
   * tokens exist.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.sessions.revoke(dto.refreshToken ?? '');
  }

  /**
   * Begin a password reset.
   *
   * 3 an hour per address, for the same reason as resend: it sends mail to an
   * address the caller names.
   */
  @Post('request-password-reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Ip() ip: string,
  ): Promise<{ message: string }> {
    await this.auth.requestPasswordReset(dto.email, ip, '');

    return { message: 'If that address is registered, a reset link is on its way.' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ip: string,
  ): Promise<{ reset: boolean }> {
    const reset = await this.auth.resetPassword(dto.token, dto.password, ip);

    if (!reset) {
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That reset link is no longer valid. Request a new one.',
      );
    }

    return { reset: true };
  }
}
