import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { UsageModule } from '../usage/usage.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { RollupThresholdScheduler } from './rollup-threshold.scheduler';
import { RollupThresholdService } from './rollup-threshold.service';

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
  /*
   * 🔴 **The scheduler is registered here, not merely written** (M25.2). A
   * worker nothing instantiates is this project's most-repeated defect — a
   * mechanism with no caller — and a monitor that never runs is the same
   * silence the deferral it watches was criticised for.
   *
   * 📌 **Its `@Cron` is inert until `ANALYTICS_ROLLUP_MONITOR_ENABLED` is set**,
   * so registering it costs a timer that returns immediately, and nothing else.
   */
  providers: [AnalyticsService, RollupThresholdService, RollupThresholdScheduler],
  exports: [AnalyticsService, RollupThresholdService],
})
export class AnalyticsModule {}
