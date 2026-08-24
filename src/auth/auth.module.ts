import { Module } from '@nestjs/common';
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
  ],
  controllers: [AuthController],
  providers: [
    AuthTokensService,
    TenantProvisioningService,
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
  exports: [AuthService, AuthTokensService, SessionsService],
})
export class AuthModule {}
