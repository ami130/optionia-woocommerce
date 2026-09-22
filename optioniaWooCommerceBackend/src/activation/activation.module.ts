import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';

import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { UserPreference } from './entities/user-preference.entity';
import { PreferencesService } from './preferences.service';

/**
 * Activation funnel (M20b.1).
 *
 * No `TypeOrmModule.forFeature`: the service reads through `DataSource` because
 * every step is a correlated subquery across seven tables that no single
 * repository owns. Registering one entity's repository here would imply an
 * ownership this module does not have.
 */
@Module({
  // `AuthModule` supplies the services behind `JwtAuthGuard` and `TenantGuard`.
  /**
   * `UserPreference` is the one entity this module owns, so it registers a
   * repository for it — unlike the funnel, which spans seven tables no single
   * repository owns and reads through `DataSource`.
   */
  imports: [AuthModule, TypeOrmModule.forFeature([UserPreference])],
  controllers: [ActivationController],
  providers: [ActivationService, PreferencesService],
  exports: [ActivationService, PreferencesService],
})
export class ActivationModule {}
