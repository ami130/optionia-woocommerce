import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RenderJob } from './entities/render-job.entity';
import { RenderJobsController } from './render-jobs.controller';
import { RenderJobsService } from './render-jobs.service';
import { RenderScheduler } from './render.scheduler';
import { RenderWorkerService } from './render-worker.service';

/**
 * The print pipeline's cloud side (M26e.4).
 *
 * Its own module rather than a controller under `orders/`: an order is a
 * historical fact the cloud records, and a render is work the cloud does. They
 * have different reasons to change — ADR-016 keeps the first immutable, while
 * the second grows a worker, a storage destination and a failure matrix.
 *
 * `AuthModule` supplies the store guards; `AuditModule` because
 * `SiteMatchGuard` records a mismatch.
 */
@Module({
  imports: [AuthModule, AuditModule, TypeOrmModule.forFeature([RenderJob])],
  controllers: [RenderJobsController],
  /*
   * 📌 **The worker is a provider, not a scheduled task.** The schedule is a
   * deployment decision and the render is a rule — the same separation
   * `BillingEventRetryService` keeps, and what lets this be driven from a test
   * or a command without dragging a timer in.
   */
  /*
   * 🔴 **The scheduler is what makes the worker RUN.** Registering a provider
   * satisfies `check-reachable` without anything calling it — which is exactly
   * how `renderPending()` shipped for one commit with no production caller, and
   * every job sat at `preparing` for ever.
   */
  providers: [RenderJobsService, RenderWorkerService, RenderScheduler],
  exports: [RenderWorkerService],
})
export class DesignModule {}
