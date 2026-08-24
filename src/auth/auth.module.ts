import { Module } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { loadConfig } from '../config/env';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantMember } from '../tenants/entities/tenant-member.entity';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthJwtService } from './jwt.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TenantGuard } from './guards/tenant.guard';
import { CapabilityGuard } from './permissions/capability.guard';
import { parseDuration, SessionsService } from './sessions.service';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';

/**
 * Authentication.
 *
 * `RefreshToken` is registered here although nothing uses it yet: 6e adds
 * rotation, and the table is already the reason 6a existed. Registering it now
 * keeps the entity's owner obvious rather than leaving it belonging to no module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      TenantMember,
      EmailVerificationToken,
      PasswordResetToken,
      RefreshToken,
    ]),
    MailModule,
    // Registered here rather than globally: the signing secret belongs to auth,
    // and a module that can mint tokens should be one that obviously does.
    JwtModule.register({ secret: loadConfig().security.jwtSecret }),
  ],
  controllers: [AuthController],
  providers: [
    AuthTokensService,
    TenantProvisioningService,
    JwtAuthGuard,
    TenantGuard,
    CapabilityGuard,
    {
      provide: AuthJwtService,
      inject: [JwtService],
      useFactory: (jwt: JwtService): AuthJwtService => {
        // Seconds, parsed once. Passing `15m` straight through would be rejected
        // by the library's duration type, and parsing at each call site is how a
        // unit mistake gets made twice.
        const FIFTEEN_MINUTES_MS = 900_000;
        const ms = parseDuration(loadConfig().security.jwtAccessTtl, FIFTEEN_MINUTES_MS);

        return new AuthJwtService(jwt, Math.floor(ms / 1000));
      },
    },
    {
      provide: SessionsService,
      inject: [getRepositoryToken(RefreshToken)],
      useFactory: (tokens: Repository<RefreshToken>): SessionsService => {
        // Parsed by unit rather than by parseInt: `720h` would otherwise become
        // 720 days, turning a tightening into a two-year token.
        const THIRTY_DAYS_MS = 30 * 86_400_000;

        return new SessionsService(
          tokens,
          parseDuration(loadConfig().security.jwtRefreshTtl, THIRTY_DAYS_MS),
        );
      },
    },
    {
      provide: AuthService,
      inject: [getRepositoryToken(User), AuthTokensService, MailService, DataSource, SessionsService, TenantProvisioningService],
      useFactory: (
        users: Repository<User>,
        tokens: AuthTokensService,
        mail: MailService,
        dataSource: DataSource,
        sessions: SessionsService,
        tenants: TenantProvisioningService,
      ): AuthService =>
        // The app URL is read once, here, so no flow builds a link from a value
        // it guessed. Links in mail must point at the dashboard, not the API.
        new AuthService(users, tokens, mail, dataSource, sessions, tenants, loadConfig().appUrl),
    },
  ],
  exports: [
    AuthService,
    AuthTokensService,
    SessionsService,
    AuthJwtService,
    JwtAuthGuard,
    TenantGuard,
    CapabilityGuard,
    // `TenantGuard` is a plain class, so Nest constructs it in whichever module
    // applies it — and that module needs the repository it injects. Exporting
    // the guard without this makes every consumer fail at boot, in a message
    // naming the consumer rather than the cause.
    //
    // The services above are unaffected: factories build them here, so they
    // arrive fully constructed.
    TypeOrmModule,
  ],
})
export class AuthModule {}
