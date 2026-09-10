import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OptionSetsModule } from '../option-sets/option-sets.module';
import { ConfigDeliveryController } from './config-delivery.controller';
import { ConfigDeliveryService } from './config-delivery.service';

/**
 * Config delivery (M9.1).
 *
 * Its own module rather than another controller under `stores/`, which already
 * carries connection, heartbeat and ownership. Delivery has a different reason
 * to change from all three — caching and document shape — and Phase 9 adds pull
 * refresh and push invalidation alongside it.
 *
 * `AuthModule` supplies the store guards; `OptionSetsModule` exports the
 * document builder rather than this module reaching into its internals.
 * `AuditModule` because `SiteMatchGuard` records a mismatch.
 */
@Module({
  imports: [AuthModule, AuditModule, OptionSetsModule],
  controllers: [ConfigDeliveryController],
  providers: [ConfigDeliveryService],
})
export class ConfigDeliveryModule {}
