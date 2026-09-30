import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { bootstrapTestApp } from './harness';

/**
 * The pricing page's source, readable without an account.
 *
 * 🔴 **The reason this suite exists.** The first attempt put this route on
 * `BillingController`, which applies `TenantGuard` at class level — and
 * `TenantGuard` does not consult `@Public()`, so the route would have refused a
 * signed-out visitor with a 401 while every type-check passed. A public route on
 * an authenticated controller is public in name only, and nothing but an
 * unauthenticated request proves otherwise.
 */
describe('Public plans (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  it('answers a caller with no credentials at all', async () => {
    const response = await request(app.getHttpServer()).get('/v1/plans');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  }, 30_000);

  it('offers only plans a prospect could actually buy', async () => {
    const response = await request(app.getHttpServer()).get('/v1/plans');

    /*
     * ⚠️ **Every row must be one checkout would accept.** `listPublic` excludes
     * plans hidden from signup and paid prices with no provider link; a pricing
     * page that advertises something the next screen refuses is worse than one
     * that omits it.
     */
    for (const plan of response.body.data) {
      expect(plan.isPublic).toBe(true);
      expect(plan.prices.length).toBeGreaterThan(0);

      for (const price of plan.prices) {
        const buyable = price.amountMinor === 0 || price.providerPriceId !== null;

        expect(buyable).toBe(true);
      }
    }
  }, 30_000);

  it('sells yearly only, as the product does', async () => {
    const response = await request(app.getHttpServer()).get('/v1/plans');

    for (const plan of response.body.data) {
      for (const price of plan.prices) {
        expect(price.interval).toBe('year');
      }
    }
  }, 30_000);

  it('leaks no tenant or platform-internal data', async () => {
    // 🔴 An unauthenticated route returning platform data must return ONLY the
    // plan catalogue — nothing about who is on which plan.
    const body = JSON.stringify(await request(app.getHttpServer()).get('/v1/plans'));

    for (const forbidden of ['tenantId', 'subscription', 'providerCustomerId', 'email']) {
      expect(body).not.toContain(forbidden);
    }
  }, 30_000);
});
