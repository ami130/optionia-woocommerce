import { Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { GRACE_DAYS, SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * The state machine a merchant's access depends on (M22.C4).
 *
 * 🔴 **Every wrong transition here costs somebody something real.** Marking a
 * paying merchant `past_due` locks them out of authoring once step D's guard
 * lands; leaving a recovered merchant's `graceEndsAt` set does the same, later
 * and more confusingly. The tests are written around those consequences rather
 * than around the code's branches.
 */
describe('SubscriptionLifecycleService', () => {
  function build(seed: Partial<Subscription> = {}) {
    const subscription = {
      id: 'sub_row_1',
      tenantId: 'tenant_1',
      provider: 'none',
      providerCustomerId: null,
      providerSubscriptionId: null,
      status: SubscriptionStatus.TRIALING,
      currentPeriodEnd: null,
      graceEndsAt: null,
      cancelAt: null,
      ...seed,
    } as Subscription;

    const subscriptions = {
      findOne: jest.fn(async () => subscription),
      save: jest.fn(async (s: Subscription) => s),
    } as unknown as Repository<Subscription>;

    const storedInvoices: Partial<Invoice>[] = [];
    const invoices = {
      findOne: jest.fn(async () => null),
      create: (input: Partial<Invoice>) => input as Invoice,
      save: jest.fn(async (i: Invoice) => {
        storedInvoices.push(i);
        return i;
      }),
    } as unknown as Repository<Invoice>;

    return {
      service: new SubscriptionLifecycleService(subscriptions, invoices),
      subscription,
      subscriptions,
      invoices,
      storedInvoices,
    };
  }

  /** A paid invoice payload in the shape this API version sends. */
  function paidInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: 'in_1',
      status: 'paid',
      currency: 'eur',
      subtotal: 2900,
      total_taxes: [{ amount: 609 }],
      total: 3509,
      created: 1_755_216_000,
      status_transitions: { paid_at: 1_755_216_060 },
      customer: 'cus_1',
      customer_address: { country: 'de' },
      parent: { subscription_details: { subscription: 'sub_1' } },
      ...overrides,
    };
  }

  describe('an event nobody handles', () => {
    /**
     * 🔴 **Ignored, not an error.** Stripe sends whatever the account subscribes
     * to; throwing would answer 5xx to a good delivery, which Stripe then
     * retries for days.
     */
    it('reports no change rather than throwing', async () => {
      const { service, subscriptions } = build();

      await expect(service.apply('customer.discount.created', {})).resolves.toEqual({
        changed: false,
        reason: 'no handler for customer.discount.created',
      });

      expect(subscriptions.save).not.toHaveBeenCalled();
    });
  });

  describe('checkout.session.completed', () => {
    it('binds the tenant to its provider identity', async () => {
      const { service, subscription } = build();

      const result = await service.apply('checkout.session.completed', {
        client_reference_id: 'tenant_1',
        customer: 'cus_1',
        subscription: 'sub_1',
      });

      expect(result.changed).toBe(true);
      expect(subscription.provider).toBe('stripe');
      expect(subscription.providerCustomerId).toBe('cus_1');
      expect(subscription.providerSubscriptionId).toBe('sub_1');
    });

    /**
     * 🔴 **A completed checkout is NOT an active subscription.** It means Stripe
     * took the payment method; `customer.subscription.updated` carries the real
     * state. Setting active here would make a failed first charge look paid.
     */
    it('leaves the status alone', async () => {
      const { service, subscription } = build();

      await service.apply('checkout.session.completed', {
        client_reference_id: 'tenant_1',
        customer: 'cus_1',
        subscription: 'sub_1',
      });

      expect(subscription.status).toBe(SubscriptionStatus.TRIALING);
    });

    /** ⚠️ Expanded objects, not just ids — Stripe sends either. */
    it('reads an expanded customer object', async () => {
      const { service, subscription } = build();

      await service.apply('checkout.session.completed', {
        client_reference_id: 'tenant_1',
        customer: { id: 'cus_expanded', object: 'customer' },
        subscription: 'sub_1',
      });

      expect(subscription.providerCustomerId).toBe('cus_expanded');
    });

    it('declines a session carrying no tenant reference', async () => {
      const { service, subscriptions } = build();

      await expect(service.apply('checkout.session.completed', {})).resolves.toEqual({
        changed: false,
        reason: 'checkout session carried no client_reference_id',
      });

      expect(subscriptions.save).not.toHaveBeenCalled();
    });
  });

  describe('customer.subscription.updated', () => {
    it.each([
      ['active', SubscriptionStatus.ACTIVE],
      ['trialing', SubscriptionStatus.TRIALING],
      ['past_due', SubscriptionStatus.PAST_DUE],
      ['paused', SubscriptionStatus.GRACE],
      ['canceled', SubscriptionStatus.CANCELLED],
      ['unpaid', SubscriptionStatus.EXPIRED],
      ['incomplete', SubscriptionStatus.TRIALING],
      ['incomplete_expired', SubscriptionStatus.EXPIRED],
    ])('maps the provider status %s', async (remote, expected) => {
      const { service, subscription } = build({ providerSubscriptionId: 'sub_1' });

      await service.apply('customer.subscription.updated', { id: 'sub_1', status: remote });

      expect(subscription.status).toBe(expected);
    });

    /**
     * 🔴 **An unmapped status changes nothing.** Stripe's union is open, and
     * writing an unknown string into the status column is how a guard later
     * fails to recognise a paying customer.
     */
    it('declines a status it does not recognise', async () => {
      const { service, subscription, subscriptions } = build({
        providerSubscriptionId: 'sub_1',
        status: SubscriptionStatus.ACTIVE,
      });

      await expect(
        service.apply('customer.subscription.updated', { id: 'sub_1', status: 'hibernating' }),
      ).resolves.toEqual({ changed: false, reason: 'unmapped provider status: hibernating' });

      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subscriptions.save).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **Recovering clears the grace clock.** A stale `graceEndsAt` on a
     * subscription that has since paid would lock out a paying merchant once
     * step D's guard reads it.
     */
    it('clears grace when the subscription becomes active again', async () => {
      const { service, subscription } = build({
        providerSubscriptionId: 'sub_1',
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: new Date('2026-10-01T00:00:00.000Z'),
      });

      await service.apply('customer.subscription.updated', { id: 'sub_1', status: 'active' });

      expect(subscription.graceEndsAt).toBeNull();
    });

    /** ⚠️ But a still-failing subscription keeps its original deadline. */
    it('keeps grace while the subscription is still past due', async () => {
      const original = new Date('2026-10-01T00:00:00.000Z');
      const { service, subscription } = build({
        providerSubscriptionId: 'sub_1',
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: original,
      });

      await service.apply('customer.subscription.updated', { id: 'sub_1', status: 'past_due' });

      expect(subscription.graceEndsAt).toEqual(original);
    });

    it('records the period end and any scheduled cancellation', async () => {
      const { service, subscription } = build({ providerSubscriptionId: 'sub_1' });

      await service.apply('customer.subscription.updated', {
        id: 'sub_1',
        status: 'active',
        current_period_end: 1_755_216_000,
        cancel_at: 1_757_808_000,
      });

      expect(subscription.currentPeriodEnd).toEqual(new Date(1_755_216_000_000));
      expect(subscription.cancelAt).toEqual(new Date(1_757_808_000_000));
    });

    /** 📌 A deleted subscription is the same handler: Stripe reports the status. */
    it('handles customer.subscription.deleted through the same path', async () => {
      const { service, subscription } = build({ providerSubscriptionId: 'sub_1' });

      await service.apply('customer.subscription.deleted', { id: 'sub_1', status: 'canceled' });

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED);
    });
  });

  describe('invoice.paid', () => {
    it('stores the invoice against the tenant and subscription', async () => {
      const { service, storedInvoices } = build({ providerSubscriptionId: 'sub_1' });

      const result = await service.apply('invoice.paid', paidInvoice());

      expect(result.changed).toBe(true);
      expect(storedInvoices).toHaveLength(1);
      expect(storedInvoices[0]).toMatchObject({
        tenantId: 'tenant_1',
        subscriptionId: 'sub_row_1',
        provider: 'stripe',
        providerInvoiceId: 'in_1',
        subtotalMinor: 2900,
        taxMinor: 609,
        totalMinor: 3509,
        taxCountry: 'DE',
        currency: 'EUR',
      });
    });

    /**
     * ⚠️ **The provider ids are not columns on `invoices`.** They resolve the
     * subscription and must not reach the row — G4's split, exercised.
     */
    it('does not write the provider ids onto the invoice row', async () => {
      const { service, storedInvoices } = build({ providerSubscriptionId: 'sub_1' });

      await service.apply('invoice.paid', paidInvoice());

      expect(storedInvoices[0]).not.toHaveProperty('providerCustomerId');
      expect(storedInvoices[0]).not.toHaveProperty('providerSubscriptionId');
    });

    /**
     * 🔴 **A paid invoice ends grace regardless of event order.** `invoice.paid`
     * and `customer.subscription.updated` are not ordered, so whichever arrives
     * first must leave the merchant in a correct state.
     */
    it('activates the subscription and clears grace', async () => {
      const { service, subscription } = build({
        providerSubscriptionId: 'sub_1',
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: new Date('2026-10-01T00:00:00.000Z'),
      });

      await service.apply('invoice.paid', paidInvoice());

      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subscription.graceEndsAt).toBeNull();
    });

    /**
     * ⚠️ **A malformed invoice is logged, not thrown.** Throwing would have
     * Stripe retry the same unmappable payload for days; the `billing_events`
     * row already holds the original.
     */
    it('declines an invoice whose totals disagree, without throwing', async () => {
      const { service, storedInvoices } = build({ providerSubscriptionId: 'sub_1' });

      const result = await service.apply('invoice.paid', paidInvoice({ total: 9999 }));

      expect(result).toEqual({ changed: false, reason: 'totals disagree: 2900 + 609 ≠ 9999' });
      expect(storedInvoices).toHaveLength(0);
    });

    /**
     * 🔴 **A redelivered invoice updates rather than duplicating.** Two rows for
     * one invoice would double a quarter's reported tax.
     */
    it('updates an invoice it has already stored', async () => {
      const existing = { id: 'inv_row_1', providerInvoiceId: 'in_1' } as Invoice;
      const { service, invoices, storedInvoices } = build({ providerSubscriptionId: 'sub_1' });
      (invoices.findOne as jest.Mock).mockResolvedValueOnce(existing);

      await service.apply('invoice.paid', paidInvoice());

      expect(storedInvoices).toHaveLength(1);
      expect(storedInvoices[0]).toMatchObject({ id: 'inv_row_1', totalMinor: 3509 });
    });
  });

  describe('invoice.payment_failed', () => {
    /**
     * 🔴 **ADR-116: a failed payment starts a clock, it does not suspend.** Most
     * failures are expired cards, and a merchant who loses sales to one will
     * churn *and* dispute the charge.
     */
    it('marks the subscription past due and starts the grace clock', async () => {
      const { service, subscription } = build({ providerSubscriptionId: 'sub_1' });

      const before = Date.now();
      await service.apply('invoice.payment_failed', paidInvoice({ status: 'open' }));

      expect(subscription.status).toBe(SubscriptionStatus.PAST_DUE);

      const elapsed = subscription.graceEndsAt!.getTime() - before;
      const fourteenDays = GRACE_DAYS * 24 * 60 * 60 * 1000;

      expect(elapsed).toBeGreaterThan(fourteenDays - 5_000);
      expect(elapsed).toBeLessThan(fourteenDays + 5_000);
    });

    /**
     * ⚠️ **The clock is not extended by further failures.** Four failed attempts
     * in a fortnight must not buy fifty-six days of grace.
     */
    it('does not extend a grace period already running', async () => {
      const original = new Date('2026-10-01T00:00:00.000Z');
      const { service, subscription } = build({
        providerSubscriptionId: 'sub_1',
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: original,
      });

      await service.apply('invoice.payment_failed', paidInvoice({ status: 'open' }));

      expect(subscription.graceEndsAt).toEqual(original);
    });

    /** 📌 Nothing is stored in `invoices`: an unpaid invoice is not a tax record. */
    it('records no invoice row', async () => {
      const { service, storedInvoices } = build({ providerSubscriptionId: 'sub_1' });

      await service.apply('invoice.payment_failed', paidInvoice({ status: 'open' }));

      expect(storedInvoices).toHaveLength(0);
    });
  });

  describe('finding the subscription', () => {
    /** ⚠️ Subscription id first; the customer id is a fallback. */
    it('falls back to the customer id when an invoice carries no subscription', async () => {
      const { service, subscriptions, storedInvoices } = build({
        providerSubscriptionId: 'sub_1',
      });

      (subscriptions.findOne as jest.Mock).mockImplementation(
        async (options: { where: Record<string, unknown> }) =>
          'providerCustomerId' in options.where
            ? ({ id: 'sub_row_1', tenantId: 'tenant_1', status: SubscriptionStatus.ACTIVE } as Subscription)
            : null,
      );

      await service.apply('invoice.paid', paidInvoice({ parent: null }));

      expect(storedInvoices).toHaveLength(1);
    });

    it('declines when neither id matches anything', async () => {
      const { service, subscriptions, storedInvoices } = build();
      (subscriptions.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.apply('invoice.paid', paidInvoice())).resolves.toEqual({
        changed: false,
        reason: 'no subscription matches this invoice',
      });

      expect(storedInvoices).toHaveLength(0);
    });
  });
});
