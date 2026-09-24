import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  BILLING_PROVIDER,
  type BillingProviderOrNull,
  requireBillingProvider,
  type VerifiedWebhook,
} from './billing-provider';
import { BillingEvent } from './entities/billing-event.entity';

/**
 * What a webhook request did, so the controller can answer correctly.
 *
 * 📌 **`duplicate` is a success, not a failure.** Stripe redelivers on any
 * non-2xx and on its own retry schedule, so an event we have already processed
 * must answer 200 — answering anything else asks for the same event for ever.
 */
export type WebhookOutcome =
  | { status: 'processed'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'unverified' };

/**
 * Verify, record, and process exactly once (M22.C2 + C3).
 *
 * ## Why verification and recording are one step
 *
 * 🔴 **An unverified webhook is an attacker's message**, and the interface says
 * so: `verifyWebhook` returns `null` rather than throwing precisely so this
 * class cannot accidentally treat a forged body as data. Nothing is written
 * before the signature checks out — recording first would let anyone fill
 * `billing_events` with whatever they liked.
 *
 * ## Why the unique index is the idempotency mechanism
 *
 * ⚠️ **Not a `SELECT` then an `INSERT`.** Stripe delivers the same event
 * concurrently often enough that a check-then-write races: two requests both
 * see no row, both insert, and the second either duplicates a charge's effects
 * or explodes. `uq_billing_events_provider_event` decides the winner in the
 * database, and the loser reads the violation as *"already handled"* —
 * which is the whole reason F90 found that index already shipped.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProviderOrNull,
    @InjectRepository(BillingEvent)
    private readonly events: Repository<BillingEvent>,
  ) {}

  /**
   * 🔴 **`rawBody`, not a parsed object.** The signature covers the exact bytes
   * Stripe sent; `main.ts` keeps them with `rawBody: true` for this one reason.
   */
  async handle(input: { rawBody: Buffer; signature: string }): Promise<WebhookOutcome> {
    /*
     * ⚠️ G3's guard, at the one place it matters. An unconfigured deployment
     * fails here — loudly, naming the absent variables — rather than at boot,
     * so every non-billing route keeps serving.
     */
    const provider = requireBillingProvider(this.provider);

    const verified = await provider.verifyWebhook(input);

    if (verified === null) {
      /*
       * 📌 Logged at `warn`, not `error`. A forged signature is expected traffic
       * on a public endpoint; paging someone for it would train them to ignore
       * the alert that matters.
       */
      this.logger.warn('Rejected a webhook whose signature did not verify');

      return { status: 'unverified' };
    }

    return this.record(provider.name, verified);
  }

  /**
   * Claim the event, or recognise that someone already has.
   *
   * 🔴 **The insert IS the claim.** Writing the row first and processing second
   * means a crash mid-processing leaves a row with `processedAt` null — a
   * visible, queryable "started and did not finish" — rather than an event that
   * was handled with no trace, or one silently dropped.
   */
  private async record(
    providerName: string,
    verified: VerifiedWebhook,
  ): Promise<WebhookOutcome> {
    const payload = this.asRecord(verified.payload);

    const event = this.events.create({
      provider: providerName,
      providerEventId: verified.eventId,
      type: verified.type,
      payload,
      processedAt: null,
      error: null,
    });

    try {
      /*
       * 📌 `save`, not `insert`, only because TypeORM's `insert` cannot type a
       * `json` column holding an index signature. Both issue a plain INSERT for
       * an entity with no id yet, and both surface `ER_DUP_ENTRY` — which is
       * what the claim below depends on.
       */
      await this.events.save(event);
    } catch (error) {
      if (this.isDuplicate(error)) {
        this.logger.log(`Ignoring a redelivered event: ${verified.eventId}`);

        return { status: 'duplicate', eventId: verified.eventId };
      }

      throw error;
    }

    /*
     * ⚠️ **Nothing acts on the event yet — C4 does that**, and saying so here
     * matters: the row is recorded and `processedAt` is set, so a reader could
     * reasonably assume a subscription was updated. It was not. C4 replaces this
     * with real lifecycle handling, and until then `billing_events` is an
     * audit trail rather than a driver of state.
     */
    await this.events.update({ id: event.id }, { processedAt: new Date() });

    return { status: 'processed', eventId: verified.eventId };
  }

  /**
   * ⚠️ **MySQL's duplicate-key error, matched on the driver's code.** Matching
   * on the message would break on a locale or version change, and matching on
   * the error class would need the driver's own types in scope here — the same
   * trap F93 hit with `Stripe.errors`.
   */
  private isDuplicate(error: unknown): boolean {
    return (error as { code?: string }).code === 'ER_DUP_ENTRY';
  }

  /**
   * The `payload` column is `json` and non-null, so an event whose body is not
   * an object still has to store something.
   *
   * 📌 Wrapped rather than rejected: the signature already proved Stripe sent
   * it, and discarding a genuine event because its shape surprised us would
   * lose the audit trail exactly when it is most wanted.
   */
  private asRecord(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };
  }
}
