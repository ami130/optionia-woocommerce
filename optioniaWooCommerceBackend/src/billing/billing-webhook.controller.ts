import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../auth/guards/public.decorator';
import { BillingWebhookService } from './billing-webhook.service';

/**
 * Stripe's callback (M22.C2).
 *
 * ## Public, and authenticated by signature instead
 *
 * 🔴 **`@Public()` because Stripe has no bearer token**, and the signature is
 * the authentication — a stronger one than a shared secret in a header, since
 * it covers the body as well as proving the sender. The route is worthless to
 * an attacker without the signing secret, and `BillingWebhookService` writes
 * nothing until verification passes.
 *
 * ## Why the throttler is skipped
 *
 * ⚠️ **A rate-limited webhook is an outage that looks like a Stripe problem.**
 * Stripe batches redeliveries after an incident, so a backlog arrives as a burst
 * that would trip the global 20/second — and every throttled event is retried,
 * which makes the burst worse. The endpoint is not unprotected: an unsigned
 * request is rejected before any work, and `uq_billing_events_provider_event`
 * bounds what a replayed valid one can do.
 */
@Public()
@SkipThrottle()
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  /**
   * 🔴 **Answers 200 for anything we successfully took responsibility for**,
   * including a redelivery we have already handled. Stripe retries every
   * non-2xx, so returning 500 on our own bug turns one failure into a
   * multi-day retry storm — and returning 4xx on a duplicate asks for the same
   * event for ever.
   *
   * ⚠️ **400 is reserved for "this did not come from Stripe"**: a missing or
   * invalid signature. That one must not be retried, because no number of
   * retries will make a forged message genuine.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; status: string }> {
    /*
     * 📌 **`rawBody` is absent unless `main.ts` sets `rawBody: true`.** Checking
     * rather than asserting: the failure is otherwise a signature mismatch,
     * which reads like a wrong secret and would be debugged in the wrong place
     * entirely.
     */
    const rawBody = request.rawBody;

    if (rawBody === undefined) {
      /*
       * 🔴 **A 500, deliberately, and the only one this route raises on
       * purpose.** This is our misconfiguration, not Stripe's bad request — and
       * Stripe retries a 5xx, so the events arriving while it is broken are
       * redelivered once `rawBody: true` is restored rather than lost. A 400
       * here would discard real events and blame the sender.
       */
      throw new Error(
        'Raw request body is unavailable — NestFactory.create needs { rawBody: true }.',
      );
    }

    if (signature === undefined || signature.trim() === '') {
      throw new BadRequestException('Missing stripe-signature header');
    }

    const outcome = await this.webhooks.handle({ rawBody, signature });

    if (outcome.status === 'unverified') {
      throw new BadRequestException('Signature verification failed');
    }

    return { received: true, status: outcome.status };
  }
}
