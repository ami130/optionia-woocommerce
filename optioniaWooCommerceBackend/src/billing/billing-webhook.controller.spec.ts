import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { BillingWebhookController } from './billing-webhook.controller';
import type { BillingWebhookService, WebhookOutcome } from './billing-webhook.service';

/**
 * The controller's own decisions: which status each outcome earns.
 *
 * 🔴 **Status codes are the entire protocol with Stripe.** It retries every
 * non-2xx on a schedule measured in days, so each mapping here is a choice
 * about what gets redelivered — and the e2e suite cannot reach the
 * misconfiguration branch at all, because the harness is correctly configured.
 */
describe('BillingWebhookController', () => {
  function build(outcome: WebhookOutcome | Error) {
    const handle = jest.fn(async () => {
      if (outcome instanceof Error) {
        throw outcome;
      }

      return outcome;
    });

    const service = { handle } as unknown as BillingWebhookService;

    return { controller: new BillingWebhookController(service), handle };
  }

  const request = { rawBody: Buffer.from('{}') } as RawBodyRequest<Request>;

  it('answers 200 with the outcome for a processed event', async () => {
    const { controller } = build({ status: 'processed', eventId: 'evt_1' });

    await expect(controller.receive(request, 'sig')).resolves.toEqual({
      received: true,
      status: 'processed',
    });
  });

  /** 🔴 A duplicate is a success: anything else asks for it again for ever. */
  it('answers 200 for a redelivered event', async () => {
    const { controller } = build({ status: 'duplicate', eventId: 'evt_1' });

    await expect(controller.receive(request, 'sig')).resolves.toEqual({
      received: true,
      status: 'duplicate',
    });
  });

  /** ⚠️ 400, not 500: no number of retries makes a forged message genuine. */
  it('answers 400 when the signature does not verify', async () => {
    const { controller } = build({ status: 'unverified' });

    await expect(controller.receive(request, 'sig')).rejects.toThrow(BadRequestException);
  });

  describe('rejections before any work is done', () => {
    it.each([
      ['an absent header', undefined],
      ['an empty header', ''],
      ['a whitespace header', '   '],
    ])('refuses %s without calling the service', async (_label, signature) => {
      const { controller, handle } = build({ status: 'processed', eventId: 'evt_1' });

      await expect(controller.receive(request, signature)).rejects.toThrow(
        'Missing stripe-signature header',
      );

      expect(handle).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔴 **The misconfiguration branch, which no e2e test can reach** — the
   * harness sets `rawBody: true`, so this path only exists for a deployment
   * that lost the flag.
   *
   * ⚠️ **A 500 is the right answer, deliberately.** This is our fault, not a bad
   * request, and Stripe retries a 5xx — so events arriving while it is broken
   * are redelivered once the flag is restored rather than discarded. A 400 would
   * throw away real events and blame the sender.
   */
  it('fails loudly, and not as a 400, when the raw body was not preserved', async () => {
    const { controller, handle } = build({ status: 'processed', eventId: 'evt_1' });
    const parsedOnly = {} as RawBodyRequest<Request>;

    const failure = controller.receive(parsedOnly, 'sig');

    await expect(failure).rejects.toThrow('NestFactory.create needs { rawBody: true }');
    await expect(failure).rejects.not.toBeInstanceOf(BadRequestException);
    expect(handle).not.toHaveBeenCalled();
  });
});
