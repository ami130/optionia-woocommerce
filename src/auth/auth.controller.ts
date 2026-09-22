import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { authThrottleLimit } from './auth-throttle';

import { getUserId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { AuthJwtService } from './jwt.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Authenticated, Public } from './guards/public.decorator';
import { TenantGuard } from './guards/tenant.guard';
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
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly jwt: AuthJwtService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Who the caller is (M13.1).
   *
   * The dashboard's shell reads this on boot: a name and email for the account
   * menu, a tenant name for the header, and `emailVerified` so an unverified
   * user is routed to the prompt rather than into the app.
   *
   * ## Authenticated, on a `@Public()` controller
   *
   * Every other route here is public by necessity — a caller signing in has no
   * token yet. This one is the opposite, so it carries `JwtAuthGuard` and
   * `TenantGuard` explicitly. **`@Public()` is a class-level default, not a
   * property of the class**, and a route that needs authentication must say so
   * rather than be moved to another controller for the sake of a decorator.
   *
   * `TenantGuard` as well as the JWT guard: the response names a tenant, and a
   * token whose tenant no longer resolves should fail at the guard rather than
   * return `tenant: null` for a reason the client cannot distinguish from a
   * genuinely tenantless account.
   *
   * ## Rate limit
   *
   * 300 an hour. A client calls this on boot and after a refresh, not per
   * request — but a dashboard left open across a working day, reloading and
   * reconnecting, should never approach it.
   */
  @Get('me')
  @Authenticated()
  @UseGuards(JwtAuthGuard, TenantGuard)
  @ApiBearerAuth('tenant')
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @ApiErrors(200, 401, 404, 429)
  async me(): Promise<{
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    locale: string | null;
    tenant: { id: string; name: string; slug: string; status: string } | null;
    role: string | null;
  }> {
    const userId = getUserId();

    if (!userId) {
      // Unreachable while `JwtAuthGuard` runs, and asserted rather than assumed:
      // a route that lost its guard must fail closed, not answer for nobody.
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const profile = await this.auth.me(userId);

    if (!profile) {
      /*
       * A live token for a user row that no longer exists -- a hard-deleted
       * account whose token has not yet expired. `401` rather than `404`,
       * because what is missing is the caller, not a resource they asked for.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return profile;
  }

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
   *
   * ⚠️ **Configurable, and the default is the production value.** A sequential
   * e2e run signs in about a hundred times, so this limit was throttling the
   * suite itself -- 4 of 78 logins returned 429 in one gate run, and an
   * unchecked login turns a 429 into a token of `undefined` and a permission
   * test that passes without sending a credential. The test environment raises
   * the number; it does not remove the rule, so the guard is still exercised by
   * `rate-limit.e2e-spec.ts`.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
  ): Promise<{
    userId: string;
    emailVerified: boolean;
    accessToken: string;
    refreshToken: string;
    tenantId: string;
    role: string;
  }> {
    const user = await this.auth.validateCredentials(dto.email, dto.password);

    if (!user) {
      /*
       * Recorded **before** the throw, and with no reason attached.
       *
       * The route answers a wrong password and an unregistered address
       * identically on purpose; a row saying which would rebuild that oracle for
       * anyone who can read the log. What a responder needs is the attempt, the
       * address tried, and the IP — all of which `record()` captures from the
       * request context.
       */
      await this.audit.record({
        action: AuditAction.USER_LOGIN_FAILED,
        resourceType: 'user',
        changes: { email: dto.email },
      });

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
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email address before signing in.',
      );
    }

    // The user agent is not read here: 6g adds the request context that carries
    // it, and reading the raw header in a controller would be a second source of
    // truth for the same value.
    const membership = await this.auth.primaryMembership(user.id);

    if (membership === null) {
      // Registration provisions a tenant in the same transaction, so this means
      // every membership was revoked — the account exists but has nowhere to act.
      throw new DomainException(
        ErrorCode.FORBIDDEN,
        'This account is not a member of any workspace.',
      );
    }

    const refreshToken = await this.sessions.issue(user.id, ip, '');
    const accessToken = this.jwt.signTenantAccess(
      user.id,
      membership.tenantId,
      membership.role,
    );

    /*
     * After the membership resolves, so the row carries the tenant it was for.
     * A sign-in row scoped to no workspace would be invisible to the tenant
     * whose data the session can reach, which is precisely who needs to see it.
     */
    await this.audit.record({
      action: AuditAction.USER_LOGGED_IN,
      resourceType: 'user',
      resourceId: user.id,
      userId: user.id,
      tenantId: membership.tenantId,
      changes: { role: membership.role },
    });

    return {
      userId: user.id,
      emailVerified: true,
      accessToken,
      refreshToken,
      tenantId: membership.tenantId,
      role: membership.role,
    };
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
  @Throttle({
    default: { limit: authThrottleLimit('THROTTLE_REFRESH_LIMIT', 60), ttl: 3_600_000 },
  })
  async refresh(
    @Body() dto: RefreshDto,
    @Ip() ip: string,
  ): Promise<{ accessToken: string; refreshToken: string; tenantId: string; role: string }> {
    const outcome = await this.sessions.rotate(dto.refreshToken ?? '', ip, '');

    if (outcome.failure !== null || outcome.token === null || outcome.userId === null) {
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That session is no longer valid. Sign in again.',
      );
    }

    /**
     * 🔴 **The access token is minted here too, and was not before.**
     *
     * This endpoint returned `{ refreshToken }` alone. Access tokens live
     * fifteen minutes (`JWT_ACCESS_TTL`), so a client refreshed its session and
     * still held an expired credential — signed out every quarter of an hour
     * with no way to continue. Nothing caught it because no client existed:
     * Phase 6 built rotation and reuse-detection correctly, and the plugin
     * authenticates with a store credential rather than a JWT.
     *
     * Found by [Phase 13 Stage 1](../../developePlan.md)'s analysis, before the
     * dashboard was written against it.
     *
     * The membership is re-read rather than carried in the refresh token,
     * because a role can change between the two: an owner who demoted a member
     * mid-session must not have the old role re-minted for another fifteen
     * minutes. Reading it here makes the refresh the moment that takes effect.
     */
    const membership = await this.auth.primaryMembership(outcome.userId);

    if (membership === null) {
      /*
       * Every membership revoked since the session began. The refresh token is
       * now spent -- `rotate()` has already replaced it -- and that is correct:
       * an account with nowhere to act should not keep a live session.
       */
      throw new DomainException(
        ErrorCode.TOKEN_INVALID,
        'That session is no longer valid. Sign in again.',
      );
    }

    return {
      accessToken: this.jwt.signTenantAccess(
        outcome.userId,
        membership.tenantId,
        membership.role,
      ),
      refreshToken: outcome.token,
      tenantId: membership.tenantId,
      role: membership.role,
    };
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
    const userId = await this.sessions.revoke(dto.refreshToken ?? '');

    if (userId) {
      // Closes the window this endpoint otherwise leaves open: the refresh
      // family dies immediately, and without this the access token keeps working
      // for the rest of its lifetime.
      await this.auth.invalidateAccessTokens(userId);

      /*
       * Inside the `if`, so an unrecognised token records nothing. The route is
       * unauthenticated and answers `204` regardless — a row for every string
       * posted to it would be an oracle telling an attacker which stolen tokens
       * are still live.
       */
      await this.audit.record({
        action: AuditAction.USER_LOGGED_OUT,
        resourceType: 'user',
        resourceId: userId,
        userId,
      });
    }
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
