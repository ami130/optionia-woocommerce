import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

/*
 * 🔴 `import Stripe = require('stripe')`, NOT a default import.
 *
 * This project sets `allowSyntheticDefaultImports` without `esModuleInterop`,
 * so `import Stripe from 'stripe'` type-checks and then emits
 * `stripe_1.default`, which is `undefined` at runtime — the package's export IS
 * the constructor. F93 hit the same gap through `Stripe.errors`; there it only
 * broke a `catch`, here it breaks construction outright.
 */
import Stripe = require('stripe');

import { loadConfig } from '../config/env';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { MailModule } from '../mail/mail.module';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { TenantMember } from '../tenants/entities/tenant-member.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BILLING_PROVIDER, type BillingProviderOrNull } from './billing-provider';
import { BillingContactsService } from './billing-contacts.service';
import { BillingNotifierService } from './billing-notifier.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingEvent } from './entities/billing-event.entity';
import { Invoice } from './entities/invoice.entity';
import { StripeProvider } from './stripe.provider';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * The pinned Stripe API version.
 *
 * 🔴 **Exported so a test can assert it, which is the whole point.** F94/E3
 * found the adapter's docblock claiming the API version was pinned while
 * nothing pinned anything — the library's default applied, and a `npm update`
 * would have moved it. A literal here plus `billing.module.spec.ts` asserting
 * the constructed client carries it turns that prose guarantee into a failing
 * test.
 *
 * ⚠️ **Raising this is a billing change, not a dependency bump.** Stripe's
 * dated versions carry breaking changes to the webhook payloads this service
 * reads; the upgrade path is to read that version's changelog, adjust the
 * mappers, and change this line in the same commit.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/**
 * Constructs the client, applying the pin.
 *
 * 🔴 **Separate from the factory so it can be tested with a version that is not
 * the library's default.** Asserting on the factory alone proved nothing: with
 * `apiVersion` deleted the library supplies its own default, which today equals
 * `STRIPE_API_VERSION`, so the assertion passed without the pin existing. Taking
 * the version as a parameter lets a test pass a value the default can never be,
 * which fails if this function stops forwarding it.
 */
export const stripeClientFactory = {
  create(secretKey: string, apiVersion: string = STRIPE_API_VERSION): Stripe {
    return new Stripe(secretKey, { apiVersion: apiVersion as Stripe.LatestApiVersion });
  },
};

/** The sanctioned construction path. The factory below uses this and nothing else. */
export function createStripeClient(secretKey: string, apiVersion?: string): Stripe {
  return stripeClientFactory.create(secretKey, apiVersion);
}

/**
 * Binds `BILLING_PROVIDER` to an implementation, once, here.
 *
 * 📌 The shape is `MailModule`'s: configuration is read in a factory and the
 * choice of driver is made in exactly one place, so no flow downstream asks
 * which provider is active. F94/E1 recorded the gap this closes —
 * `StripeProvider` carried `@Injectable()` while nothing could construct it,
 * because its constructor takes a `Stripe` client and a secret rather than
 * injectable classes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BillingEvent,
      Invoice,
      Subscription,
      Tenant,
      PlanPrice,
      TenantMember,
    ]),

    /* 📌 For ADR-116's dunning mail, which had no way to reach a person (F115). */
    MailModule,
  ],
  controllers: [BillingWebhookController],
  providers: [
    BillingWebhookService,
    SubscriptionLifecycleService,
    BillingContactsService,
    BillingNotifierService,
    {
      provide: BILLING_PROVIDER,
      useFactory: (): BillingProviderOrNull => {
        const config = loadConfig();

        /*
         * ⚠️ **An unconfigured provider is `null`, not a throw.** Billing is not
         * yet wired to a live account, and every test in this repository boots
         * the app without Stripe keys — refusing to start would make "no
         * billing" unrunnable rather than merely unavailable.
         *
         * 🔴 **Callers reach it through `requireBillingProvider`, not by
         * injecting the token directly.** I first wrote here that *"the token's
         * type says so"* — it does not and cannot: an injection token is a bare
         * symbol, so `@Inject(BILLING_PROVIDER) p: BillingProvider` compiles and
         * then holds `null` at runtime (G2). The accessor is a real signature,
         * so the compiler enforces what the comment used to only assert.
         *
         * 📌 Production is guarded there rather than here: a deployment missing
         * its keys fails when a merchant tries to pay, with a named reason,
         * instead of taking every other route down with it.
         */
        if (config.billing.secretKey === null || config.billing.webhookSecret === null) {
          new Logger('BillingModule').warn(
            'No billing provider configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent) — checkout and webhooks are unavailable.',
          );

          return null;
        }

        return new StripeProvider(
          createStripeClient(config.billing.secretKey),
          config.billing.webhookSecret,
        );
      },
    },
  ],
  exports: [BILLING_PROVIDER, BillingWebhookService, SubscriptionLifecycleService],
})
export class BillingModule {}
