import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Order reporting (M12.7).
 *
 * Its own module rather than a controller under `stores/`: this writes
 * financial history for Phase 25 analytics, which has a different reason to
 * change from connection, heartbeat and ownership.
 *
 * `AuthModule` supplies the store guards; `AuditModule` because `SiteMatchGuard`
 * records a mismatch.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
