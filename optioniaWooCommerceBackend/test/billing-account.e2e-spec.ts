/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { Invoice } from '../src/billing/entities/invoice.entity';
import { InvoiceStatus, SubscriptionStatus } from '../src/common/database/enums';
import { Subscription } from '../src/subscriptions/entities/subscription.entity';
import { client, createHarness, type Harness } from './harness';

/**
 * What a merchant can see about their own billing (M22.E1–E2), against MySQL.
 *
 * 🔴 **The read paths are the half a unit test cannot prove.** `listInvoices`
 * is a `WHERE tenantId` and an `ORDER BY`; only the database can say whether the
 * scope holds and whether the ordering is what a merchant sees. Isolation in
 * particular — one merchant must never see another's invoices — is a property
 * of the query, not of the mapper above it.
 *
 * 📌 **E3 and E4 are not exercised here.** Both call the provider on a
 * subscription this suite has no real Stripe counterpart for; their logic is
 * covered by `billing-account.service.spec.ts`, and their wiring by the boot
 * check that both routes are mapped.
 */
describe('Billing account (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    h = await createHarness('billacct');
    dataSource = h.app.get(DataSource);
  }, 120_000);

  afterAll(async () => {
    /* Invoices are RESTRICT on tenant, so they go first. Every run's rows. */
    await dataSource.query(
      `DELETE i FROM invoices i JOIN tenants t ON t.id = i.tenantId WHERE t.slug LIKE 'billacct-%'`,
    );

    await h.close();
  });

  /** Give a tenant's subscription a provider identity and a pinned price. */
  async function makePaid(tenantId: string): Promise<Subscription> {
    const repo = dataSource.getRepository(Subscription);
    const subscription = await repo.findOneByOrFail({ tenantId });

    subscription.provider = 'stripe';
    subscription.providerSubscriptionId = `sub_${tenantId.slice(-8)}`;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.currentPeriodEnd = new Date('2026-12-01T00:00:00.000Z');

    return repo.save(subscription);
  }

  async function addInvoice(
    tenantId: string,
    subscriptionId: string,
    over: Partial<Invoice> = {},
  ): Promise<Invoice> {
    const repo = dataSource.getRepository(Invoice);

    return repo.save(
      repo.create({
        tenantId,
        subscriptionId,
        provider: 'stripe',
        providerInvoiceId: `in_${Math.random().toString(36).slice(2, 12)}`,
        status: InvoiceStatus.PAID,
        currency: 'USD',
        subtotalMinor: 2900,
        taxMinor: 0,
        totalMinor: 2900,
        issuedAt: new Date('2026-09-01T00:00:00.000Z'),
        paidAt: new Date('2026-09-01T00:01:00.000Z'),
        hostedUrl: 'https://invoice.stripe.com/i/one',
        ...over,
      }),
    );
  }

  describe('E1 — GET /billing/subscription', () => {
    it('reports the plan a fresh tenant is on', async () => {
      const token = await h.tenant('e1-fresh');
      const api = client(h.app, token);

      const response = await api.get('/billing/subscription');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        planCode: 'free',
        status: SubscriptionStatus.TRIALING,
      });
    }, 60_000);

    /**
     * 🔴 **The amount comes from the PINNED price**, which provisioning set —
     * ADR-117's grandfathering made visible to the merchant.
     */
    it('reports the pinned price, not a figure computed here', async () => {
      const token = await h.tenant('e1-pinned');
      const api = client(h.app, token);

      const response = await api.get('/billing/subscription');

      /* The free plan is $0/month, pinned at provisioning. */
      expect(response.body.data).toMatchObject({
        currency: 'USD',
        amountMinor: 0,
        interval: 'month',
      });
    }, 60_000);

    it('needs authentication', async () => {
      const response = await request(h.app.getHttpServer()).get('/v1/billing/subscription');

      expect(response.status).toBe(401);
    }, 60_000);
  });

  describe('E2 — GET /billing/invoices', () => {
    it('returns this tenant’s invoices, newest first', async () => {
      const token = await h.tenant('e2-list');
      const tenantId = await h.tenantIdOf('e2-list');
      const subscription = await makePaid(tenantId);

      await addInvoice(tenantId, subscription.id, {
        issuedAt: new Date('2026-07-01T00:00:00.000Z'),
        totalMinor: 1000,
        subtotalMinor: 1000,
      });
      await addInvoice(tenantId, subscription.id, {
        issuedAt: new Date('2026-09-01T00:00:00.000Z'),
        totalMinor: 3000,
        subtotalMinor: 3000,
      });

      const response = await client(h.app, token).get('/billing/invoices');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.map((i: { totalMinor: number }) => i.totalMinor)).toEqual([
        3000, 1000,
      ]);
    }, 60_000);

    /**
     * 🔴 **The isolation test, and the reason this suite exists.** A billing
     * list that lost its `WHERE tenantId` would show one merchant another's
     * invoices — money, addresses and tax ids — and every unit test would still
     * pass, because the scope is in the query.
     */
    it('never returns another tenant’s invoices', async () => {
      const tokenA = await h.tenant('e2-iso-a');
      const tenantA = await h.tenantIdOf('e2-iso-a');
      const subA = await makePaid(tenantA);

      await h.tenant('e2-iso-b');
      const tenantB = await h.tenantIdOf('e2-iso-b');
      const subB = await makePaid(tenantB);

      await addInvoice(tenantA, subA.id, { totalMinor: 1111, subtotalMinor: 1111 });
      await addInvoice(tenantB, subB.id, { totalMinor: 2222, subtotalMinor: 2222 });

      const response = await client(h.app, tokenA).get('/billing/invoices');

      const totals = response.body.data.map((i: { totalMinor: number }) => i.totalMinor);

      expect(totals).toContain(1111);
      expect(totals).not.toContain(2222);
    }, 60_000);

    it('honours the limit', async () => {
      const token = await h.tenant('e2-limit');
      const tenantId = await h.tenantIdOf('e2-limit');
      const subscription = await makePaid(tenantId);

      await addInvoice(tenantId, subscription.id);
      await addInvoice(tenantId, subscription.id);
      await addInvoice(tenantId, subscription.id);

      const response = await client(h.app, token).get('/billing/invoices?limit=2');

      expect(response.body.data).toHaveLength(2);
    }, 60_000);

    /** ⚠️ An unbounded list is a denial-of-service someone finds by accident. */
    it('refuses a limit above the cap', async () => {
      const token = await h.tenant('e2-cap');

      const response = await client(h.app, token).get('/billing/invoices?limit=5000');

      expect(response.status).toBe(400);
    }, 60_000);

    it('returns an empty list for a tenant with no invoices', async () => {
      const token = await h.tenant('e2-empty');

      const response = await client(h.app, token).get('/billing/invoices');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    }, 60_000);
  });

  describe('E3/E4 — the write routes exist and are guarded', () => {
    /**
     * 📌 **Reachability and refusal, not provider behaviour.** Both call Stripe
     * for a subscription this suite has no real counterpart for; what matters
     * here is that the routes are wired and that a free-tier tenant is turned
     * away before any provider call is attempted.
     */
    it('refuses a plan change for a tenant with no paid subscription', async () => {
      const token = await h.tenant('e3-free');

      const response = await client(h.app, token).post('/billing/plan', {
        planPriceId: '01a0d000-0000-7000-8000-00000000beef',
      });

      /*
       * ⚠️ 400 — "no paid subscription to change" — rather than 404. The route
       * exists and the request is well-formed; what is wrong is the account's
       * state, and saying 404 would read as a missing endpoint.
       */
      expect(response.status).toBe(400);
    }, 60_000);

    it('refuses a cancellation for a tenant with no paid subscription', async () => {
      const token = await h.tenant('e4-free');

      const response = await request(h.app.getHttpServer())
        .delete('/v1/billing/subscription')
        .set('Authorization', `Bearer ${token}`)
        .send({ atPeriodEnd: true });

      expect(response.status).toBe(400);
    }, 60_000);

    it('validates the plan price id rather than passing it through', async () => {
      const token = await h.tenant('e3-invalid');

      const response = await client(h.app, token).post('/billing/plan', {
        planPriceId: 'not-a-uuid',
      });

      expect(response.status).toBe(400);
    }, 60_000);
  });
});
