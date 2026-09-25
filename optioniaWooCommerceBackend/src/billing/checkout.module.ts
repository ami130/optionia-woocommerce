import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BillingAccountService } from './billing-account.service';
import { BillingModule } from './billing.module';
import { Invoice } from './entities/invoice.entity';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';

/**
 * The merchant-facing half of billing, kept apart from the provider wiring.
 *
 * 🔴 **Split because `AuthModule` initialises at import time.**
 * `auth.module.ts` calls `loadConfig()` at module scope, and it drags its whole
 * repository graph with it — so putting the checkout controller in
 * `BillingModule` made that module impossible to unit-test without standing up
 * a dozen unrelated stubs. That is the test telling the truth about a boundary,
 * not an obstacle to work around with more mocks.
 *
 * 📌 **The two halves have opposite auth models**, which is the deeper reason
 * the split reads well: the webhook is `@Public()` and authenticated by
 * signature because Stripe carries no token, while this is an ordinary
 * authenticated merchant request behind the full guard chain.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlanPrice, Subscription, Tenant, Invoice]),
    AuthModule,
    BillingModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService, BillingAccountService],
  exports: [CheckoutService, BillingAccountService],
})
export class CheckoutModule {}
