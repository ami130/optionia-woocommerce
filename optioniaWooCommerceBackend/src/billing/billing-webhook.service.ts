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
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

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
    private readonly lifecycle: SubscriptionLifecycleService,
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

    let claimed = event;

    try {
      /*
       * 📌 `save`, not `insert`, only because TypeORM's `insert` cannot type a
       * `json` column holding an index signature. Both issue a plain INSERT for
       * an entity with no id yet, and both surface `ER_DUP_ENTRY` — which is
       * what the claim below depends on.
       */
      await this.events.save(event);
    } catch (error) {
      if (!this.isDuplicate(error)) {
        throw error;
      }

      /*
       * 🔴 **A duplicate is not automatically "already handled" (N1).**
       *
       * The row is inserted *before* the handler runs, so a handler that throws
       * leaves the event claimed and unprocessed. The 5xx we return asks the
       * provider to retry — and the retry then hit this branch, saw the row,
       * answered 200, and **never ran the handler again**. A merchant whose
       * `invoice.paid` failed once stayed `past_due` for ever, with the
       * provider's retries consumed by our own idempotency check.
       *
       * ⚠️ **Measured before it was fixed**: a probe with a handler that failed
       * once then succeeded showed it running exactly once, the retry returning
       * `duplicate`. The docblock above called the unprocessed row *"a visible,
       * queryable started-and-did-not-finish"* — visible to nobody, because
       * nothing looked.
       *
       * 📌 **`processedAt` is the discriminator.** A row that finished is a
       * genuine duplicate and must stay a no-op; a row that did not is work
       * still owed, and this delivery is the chance to complete it.
       */
      const existing = await this.events.findOne({
        where: { provider: providerName, providerEventId: verified.eventId },
      });

      if (existing === null || existing.processedAt !== null) {
        this.logger.log(`Ignoring a redelivered event: ${verified.eventId}`);

        return { status: 'duplicate', eventId: verified.eventId };
      }

      this.logger.warn(
        `Re-processing ${verified.eventId}, claimed but never completed` +
          (existing.error === null ? '' : `: ${existing.error}`),
      );

      claimed = existing;
    }

    /*
     * 🔴 **`processedAt` is set only after the work succeeds.** A row claimed
     * and then left unprocessed is a visible, queryable "started and did not
     * finish"; setting the timestamp first would make a crash indistinguishable
     * from a success, in the one table an operator consults to find out.
     *
     * ⚠️ **A handler failure is recorded and rethrown**, so Stripe's retry can
     * do its job. The `error` column exists for exactly this and had no writer
     * until now.
     */
    try {
      const result = await this.lifecycle.apply(verified.type, verified.payload);

      /*
       * ⚠️ **`error` is cleared, not left behind.** A row that succeeded on a
       * retry still carrying the first attempt's message would read as a
       * permanent failure to whoever queries for them later — which is exactly
       * the query M23.4 will add.
       */
      await this.events.update({ id: claimed.id }, { processedAt: new Date(), error: null });

      this.logger.log(
        result.changed
          ? `${verified.type}: ${result.detail}`
          : `${verified.type}: no change (${result.reason})`,
      );
    } catch (error) {
      await this.events.update({ id: claimed.id }, { error: (error as Error).message });

      throw error;
    }

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
