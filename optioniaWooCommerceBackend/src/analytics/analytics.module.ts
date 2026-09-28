import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { UsageModule } from '../usage/usage.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Merchant analytics (M25.3).
 *
 * `UsageModule` supplies `PlanFeatureGuard` — analytics is a paid feature, and
 * `plans.features` has said so since Phase 22 without anything reading it.
 *
 * 📌 **No `TypeOrmModule.forFeature` here.** Everything is a read across
 * `order_events`, `order_selections` and live configuration, expressed as SQL
 * against `DataSource`; the entities are registered by the modules that own
 * them, and registering them twice would imply this module writes them.
 */
@Module({
  imports: [AuthModule, UsageModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
