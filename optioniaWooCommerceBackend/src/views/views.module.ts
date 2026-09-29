import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ViewsController } from './views.controller';
import { ViewsService } from './views.service';

/**
 * Option view counts (M25.1).
 *
 * Its own module rather than a controller under `orders/`: a view is not an
 * order, is aggregated rather than individual, and carries nothing about a
 * person — three different reasons to change.
 *
 * `AuthModule` supplies the store guards; `AuditModule` because `SiteMatchGuard`
 * records a mismatch.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ViewsController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
