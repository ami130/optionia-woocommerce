import { Logger, Module } from '@nestjs/common';

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
import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';
import { StripeProvider } from './stripe.provider';

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
  providers: [
    {
      provide: BILLING_PROVIDER,
      useFactory: (): BillingProvider | null => {
        const config = loadConfig();

        /*
         * ⚠️ **An unconfigured provider is `null`, not a throw.** Billing is not
         * yet wired to a live account, and every test in this repository boots
         * the app without Stripe keys — refusing to start would make "no
         * billing" unrunnable rather than merely unavailable. Callers must
         * handle `null`; the token's type says so.
         *
         * 🔴 Production is the exception and is guarded at the call sites, not
         * here: a deployment missing the keys should fail when a merchant tries
         * to pay, with a logged reason, rather than take the whole API down.
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
  exports: [BILLING_PROVIDER],
})
export class BillingModule {}
