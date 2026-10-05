import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RenderJobsController } from './render-jobs.controller';
import { RenderJobsService } from './render-jobs.service';

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
  imports: [AuthModule, AuditModule],
  controllers: [RenderJobsController],
  providers: [RenderJobsService],
})
export class DesignModule {}
