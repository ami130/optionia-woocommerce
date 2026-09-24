import { Repository } from 'typeorm';

import type { BillingProvider, VerifiedWebhook } from './billing-provider';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingEvent } from './entities/billing-event.entity';
import type { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * The webhook pipeline: verify, record once, answer correctly (M22.C2 + C3).
 *
 * 🔴 **Every test here is about a failure that answers 200 or 400 wrongly.**
 * Stripe retries every non-2xx, so the cost of getting these backwards is not a
 * single bad response — it is the same event redelivered for days, or a forged
 * one accepted silently.
 */
describe('BillingWebhookService', () => {
  const verified: VerifiedWebhook = {
    eventId: 'evt_123',
    type: 'invoice.paid',
    payload: { id: 'in_123', object: 'invoice' },
  };

  function build(
    overrides: {
      verify?: BillingProvider['verifyWebhook'];
      save?: jest.Mock;
      update?: jest.Mock;
      apply?: jest.Mock;
    } = {},
  ) {
    const save = overrides.save ?? jest.fn(async (e: BillingEvent) => e);
    const update = overrides.update ?? jest.fn(async () => ({ affected: 1 }));
    const apply =
      overrides.apply ?? jest.fn(async () => ({ changed: true, detail: 'did a thing' }));

    const provider = {
      name: 'stripe',
      verifyWebhook: overrides.verify ?? jest.fn(async () => verified),
    } as unknown as BillingProvider;

    const events = {
      create: (input: Partial<BillingEvent>) => ({ id: 'row_1', ...input }) as BillingEvent,
      save,
      update,
    } as unknown as Repository<BillingEvent>;

    const lifecycle = { apply } as unknown as SubscriptionLifecycleService;

    return {
      service: new BillingWebhookService(provider, events, lifecycle),
      provider,
      save,
      update,
      apply,
    };
  }

  const input = { rawBody: Buffer.from('{"id":"evt_123"}'), signature: 'sig' };

  describe('verification', () => {
    /**
     * 🔴 **Nothing is written before the signature verifies.** Recording first
     * would let anyone fill `billing_events` with whatever they liked, on a
     * public endpoint.
     */
    it('records nothing when the signature does not verify', async () => {
      const { service, save } = build({ verify: jest.fn(async () => null) });

      await expect(service.handle(input)).resolves.toEqual({ status: 'unverified' });
      expect(save).not.toHaveBeenCalled();
    });

    /** ⚠️ The exact bytes, not a re-serialised object — the signature covers them. */
    it('passes the raw body through to the provider unchanged', async () => {
      const { service, provider } = build();

      await service.handle(input);

      expect(provider.verifyWebhook).toHaveBeenCalledWith(input);
    });

    /**
     * 🔴 G3's guard, exercised. An unconfigured deployment must fail here with a
     * named reason rather than at boot, so non-billing routes keep serving.
     */
    it('fails with a reason an operator can act on when no provider is configured', async () => {
      const events = {} as unknown as Repository<BillingEvent>;
      const lifecycle = {} as unknown as SubscriptionLifecycleService;
      const service = new BillingWebhookService(null, events, lifecycle);

      await expect(service.handle(input)).rejects.toThrow(
        'No billing provider is configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent).',
      );
    });
  });

  describe('recording', () => {
    it('stores the verified event and marks it processed', async () => {
      const { service, save, update } = build();

      await expect(service.handle(input)).resolves.toEqual({
        status: 'processed',
        eventId: 'evt_123',
      });

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'stripe',
          providerEventId: 'evt_123',
          type: 'invoice.paid',
          payload: { id: 'in_123', object: 'invoice' },
          processedAt: null,
        }),
      );

      expect(update).toHaveBeenCalledWith({ id: 'row_1' }, { processedAt: expect.any(Date) });
    });

    /**
     * 🔴 **The row is written before it is marked processed**, so a crash leaves
     * a queryable "started and did not finish" rather than an event handled with
     * no trace.
     */
    it('writes the row before marking it processed', async () => {
      const order: string[] = [];
      const save = jest.fn(async (e: BillingEvent) => {
        order.push('save');
        return e;
      });
      const update = jest.fn(async () => {
        order.push('update');
        return { affected: 1 };
      });

      await build({ save, update }).service.handle(input);

      expect(order).toEqual(['save', 'update']);
    });

    /**
     * ⚠️ The `payload` column is `json` and non-null. A non-object body is
     * wrapped rather than dropped: the signature already proved Stripe sent it,
     * and discarding it would lose the audit trail exactly when it is wanted.
     */
    it('wraps a payload that is not an object', async () => {
      const { service, save } = build({
        verify: jest.fn(async () => ({ ...verified, payload: 'surprise' })),
      });

      await service.handle(input);

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { value: 'surprise' } }),
      );
    });

    it('wraps an array payload, which is an object but not a record', async () => {
      const { service, save } = build({
        verify: jest.fn(async () => ({ ...verified, payload: [1, 2] })),
      });

      await service.handle(input);

      expect(save).toHaveBeenCalledWith(expect.objectContaining({ payload: { value: [1, 2] } }));
    });
  });

  describe('idempotency', () => {
    /**
     * 🔴 **A duplicate is a success.** Stripe redelivers on any non-2xx, so
     * answering anything but 200 for an event we have already handled asks for
     * the same event for ever.
     *
     * ⚠️ The unique index decides this, not a `SELECT` first: two concurrent
     * deliveries both see no row, both insert, and only the database can break
     * the tie.
     */
    it('treats a duplicate-key violation as already handled', async () => {
      const save = jest.fn(async () => {
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      });
      const { service, update } = build({ save });

      await expect(service.handle(input)).resolves.toEqual({
        status: 'duplicate',
        eventId: 'evt_123',
      });

      /* 📌 And it does NOT re-mark the first delivery's row as processed. */
      expect(update).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **Only `ER_DUP_ENTRY` means "already handled".** Swallowing every
     * database error as a duplicate would answer 200 to a connection failure,
     * and Stripe would never redeliver the event we in fact lost.
     */
    it('rethrows a database error that is not a duplicate key', async () => {
      const save = jest.fn(async () => {
        throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      });

      await expect(build({ save }).service.handle(input)).rejects.toThrow('connection lost');
    });

    it('rethrows an error carrying no code at all', async () => {
      const save = jest.fn(async () => {
        throw new Error('something else entirely');
      });

      await expect(build({ save }).service.handle(input)).rejects.toThrow(
        'something else entirely',
      );
    });
  });

  /**
   * C4's wiring: the event reaches the lifecycle, and a handler failure is both
   * recorded and rethrown.
   */
  describe('dispatch', () => {
    it('hands the verified type and payload to the lifecycle', async () => {
      const { service, apply } = build();

      await service.handle(input);

      expect(apply).toHaveBeenCalledWith('invoice.paid', { id: 'in_123', object: 'invoice' });
    });

    /**
     * 🔴 **`processedAt` is set only after the handler succeeds.** Marking it
     * first would make a crash indistinguishable from a success in the one table
     * an operator consults to find out which it was.
     */
    it('does not mark an event processed when the handler throws', async () => {
      const apply = jest.fn(async () => {
        throw new Error('lifecycle exploded');
      });
      const { service, update } = build({ apply });

      await expect(service.handle(input)).rejects.toThrow('lifecycle exploded');

      expect(update).not.toHaveBeenCalledWith(
        { id: 'row_1' },
        expect.objectContaining({ processedAt: expect.anything() }),
      );
    });

    /**
     * ⚠️ **The failure is recorded and rethrown**, so the row says what went
     * wrong and Stripe's retry still gets its 5xx. `billing_events.error` had no
     * writer until now.
     */
    it('records the reason on the row and rethrows', async () => {
      const apply = jest.fn(async () => {
        throw new Error('lifecycle exploded');
      });
      const { service, update } = build({ apply });

      await expect(service.handle(input)).rejects.toThrow('lifecycle exploded');

      expect(update).toHaveBeenCalledWith({ id: 'row_1' }, { error: 'lifecycle exploded' });
    });

    /** 📌 An event with no handler is still recorded and still answers 200. */
    it('marks an unhandled event processed rather than failing', async () => {
      const apply = jest.fn(async () => ({ changed: false, reason: 'no handler for x' }));
      const { service, update } = build({ apply });

      await expect(service.handle(input)).resolves.toEqual({
        status: 'processed',
        eventId: 'evt_123',
      });

      expect(update).toHaveBeenCalledWith({ id: 'row_1' }, { processedAt: expect.any(Date) });
    });
  });
});
