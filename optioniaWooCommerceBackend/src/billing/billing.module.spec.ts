import { Test } from '@nestjs/testing';

/* 🔴 See BillingModule: a default import of `stripe` is `undefined` at runtime. */
import Stripe = require('stripe');

import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';
import {
  BillingModule,
  createStripeClient,
  STRIPE_API_VERSION,
  stripeClientFactory,
} from './billing.module';
import { StripeProvider } from './stripe.provider';

/**
 * The guards F94/E1 and F94/E3 asked for: the provider is constructible, and
 * the API version is pinned by something that fails when it moves.
 */
describe('BillingModule', () => {
  const saved = { ...process.env };

  /**
   * `loadConfig` validates the whole environment, not just the billing keys, so
   * a partial one fails on JWT_SECRET long before reaching the factory's
   * decision — the same baseline `MailModule`'s suite keeps, for the same
   * reason.
   */
  const VALID_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    DB_SSL: 'false',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
  };

  async function providerWith(
    env: Record<string, string | undefined>,
  ): Promise<{ provider: BillingProvider | null; close: () => Promise<void> }> {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, VALID_ENV);

    Object.entries(env).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });

    const moduleRef = await Test.createTestingModule({ imports: [BillingModule] }).compile();

    return {
      provider: moduleRef.get<BillingProvider | null>(BILLING_PROVIDER),
      close: () => moduleRef.close(),
    };
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  /**
   * 🔴 **This is the test that makes the pin real.** Asserting
   * `STRIPE_API_VERSION === '2026-08-26.dahlia'` would only assert a constant
   * equals itself, and would still pass after an upgrade moved the version the
   * library actually speaks.
   *
   * Comparing against the library's own default means an upgrade that changes
   * it **fails here** — the intended outcome, since a new dated version carries
   * breaking changes to the webhook payloads this service reads. The fix on
   * that failure is never to edit this expectation alone: read the changelog,
   * adjust the mappers, then move the pin.
   */
  it('pins the API version to the version this code was written against', () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });

  it('constructs a provider that declares the pinned version', async () => {
    const { provider, close } = await providerWith({
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    });

    expect(provider).toBeInstanceOf(StripeProvider);

    /*
     * ⚠️ Reaching into the private client on purpose. The alternative is
     * trusting that the factory passed what it read, which is the assumption
     * F94/E3 found to be false.
     */
    const stripe = (provider as unknown as { stripe: Stripe }).stripe;

    expect(stripe.getApiField('version')).toBe(STRIPE_API_VERSION);

    await close();
  });

  /**
   * 🔴 **Kills the mutation where the factory constructs `new Stripe(...)`
   * itself.** Version equality alone could not: an unpinned client inherits the
   * library default, which today equals the pin, so bypassing the helper left
   * every assertion green. Asserting the helper was *called* is independent of
   * what the default happens to be.
   */
  it('builds its client through the pinned construction path', async () => {
    const spy = jest.spyOn(stripeClientFactory, 'create');

    try {
      const { close } = await providerWith({
        STRIPE_SECRET_KEY: 'sk_test_fake',
        STRIPE_WEBHOOK_SECRET: 'whsec_fake',
      });

      expect(spy).toHaveBeenCalledWith('sk_test_fake', undefined);

      await close();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * 🔴 **The assertion above is not sufficient, and this one says why.**
   *
   * Deleting `apiVersion:` from the factory left every test green: with no
   * explicit version the library applies its own default, which *today* equals
   * the pinned literal — so the check passed without the mechanism it claims to
   * verify. That is precisely the defect this session keeps finding, and it
   * would have shipped a pin that stops pinning the moment the two diverge.
   *
   * Constructing against a version the library's default can never be proves
   * the factory passes what it was given, independently of what the default
   * happens to be.
   */
  it('passes the pinned version through rather than inheriting the default', () => {
    // A version the library's default can never be, so a pass cannot be a coincidence.
    const arbitrary = '2020-08-27';

    expect(Stripe.API_VERSION).not.toBe(arbitrary);
    expect(createStripeClient('sk_test_fake', arbitrary).getApiField('version')).toBe(arbitrary);
  });

  /** And by default it forwards the pin, which is what the factory relies on. */
  it('defaults to the pinned version', () => {
    expect(createStripeClient('sk_test_fake').getApiField('version')).toBe(STRIPE_API_VERSION);
  });

  /**
   * ⚠️ Unconfigured resolves to `null` rather than throwing, so the app boots
   * without billing — the state every test in this repository runs in.
   */
  it('resolves to null when no credentials are configured', async () => {
    const { provider, close } = await providerWith({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    });

    expect(provider).toBeNull();

    await close();
  });

  /** 🔴 A half-filled `.env` is not a configured one (F78's lesson, applied). */
  it('treats an empty secret as absent rather than as configured', async () => {
    const { provider, close } = await providerWith({
      STRIPE_SECRET_KEY: '   ',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    });

    expect(provider).toBeNull();

    await close();
  });

  /** ⚠️ Both halves are required: a secret without a webhook secret cannot
   * verify what Stripe sends back, so it is not a usable configuration. */
  it('refuses a secret key with no webhook secret', async () => {
    const { provider, close } = await providerWith({
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: undefined,
    });

    expect(provider).toBeNull();

    await close();
  });
});
