import { Injectable, Logger } from '@nestjs/common';

import { MailKind } from '../common/database/enums';
import { MailService } from '../mail/mail.service';
import { paymentFailed, trialEnding } from '../mail/templates/billing.templates';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { loadConfig } from '../config/env';
import { BillingContactsService } from './billing-contacts.service';

/**
 * Telling a merchant about their billing (M23.3, ADR-116).
 *
 * 🔴 **ADR-116 promised this and there was none.** *"Grace: everything works,
 * with a dashboard banner and dunning mail."* The banner shipped in F113; the
 * mail was unbuildable until F115 gave billing a way to address a person. A
 * merchant whose card failed got a fourteen-day clock and no notification, so
 * the first they learned was authoring going read-only.
 *
 * ## Why this is a separate service
 *
 * 📌 **The lifecycle handler decides *whether*, this decides *how*.** Keeping
 * template choice, recipient resolution and the dashboard URL out of the state
 * machine means a change to the wording cannot accidentally change when a
 * grace period starts.
 */
@Injectable()
export class BillingNotifierService {
  private readonly logger = new Logger(BillingNotifierService.name);

  constructor(
    private readonly contacts: BillingContactsService,
    private readonly mail: MailService,
  ) {}

  /**
   * A payment failed and the clock has started.
   *
   * ⚠️ **Called once per lapse, not once per failure.** Stripe's dunning fires
   * `invoice.payment_failed` several times; the caller uses `graceEndsAt` to
   * recognise the first, because the mail service has suppression but no
   * dedupe and four identical warnings read as a broken system.
   */
  async paymentFailed(subscription: Subscription): Promise<void> {
    const deadline = subscription.graceEndsAt;

    if (deadline === null) {
      /*
       * 📌 Defensive: the caller only reaches here having just set it. Sending
       * a dunning notice with no deadline would be worse than sending none —
       * "act by <nothing>" is a message that cannot be acted on.
       */
      this.logger.warn('Skipped dunning mail: the subscription has no grace deadline');

      return;
    }

    /*
     * 📌 **Read once, not once per recipient.** `loadConfig()` re-validates the
     * whole environment on every call — NODE_ENV, database, JWT, CORS — and the
     * render below runs for each contact.
     */
    const url = `${loadConfig().appUrl}/subscription`;

    await this.notify(subscription.tenantId, (name) =>
      paymentFailed(name, formatDeadline(deadline), url),
    );
  }

  /**
   * A trial ends in a few days.
   *
   * ⚠️ **Takes the date, not the subscription's own `trialEndsAt`.** The caller
   * has the *provider's* `trial_end`, which is authoritative about what will
   * actually be charged and when — and can differ from ours after a mid-trial
   * upgrade carried the remainder across (F110).
   *
   * 📌 Spreading the entity with a replaced date was the first attempt, and the
   * compiler refused it: a `Subscription` carries a protected `assignId`, so a
   * literal is not one. Passing the date is the honest shape anyway.
   */
  async trialEnding(tenantId: string, endsAt: Date): Promise<void> {
    const url = `${loadConfig().appUrl}/subscription`;

    await this.notify(
      tenantId,
      (name) => trialEnding(name, formatDeadline(endsAt), url),
      MailKind.LIFECYCLE,
    );
  }

  /**
   * 🔴 **Every contact is attempted, and one failure does not stop the rest.**
   * A `Promise.all` would let a single bad address deny the news to the person
   * who can actually fix the card.
   */
  private async notify(
    tenantId: string,
    render: (name: string) => { subject: string; text: string; html: string },
    kind: MailKind = MailKind.TRANSACTIONAL,
  ): Promise<void> {
    const recipients = await this.contacts.forTenant(tenantId);

    if (recipients.length === 0) {
      /*
       * ⚠️ **Not an error.** A tenant whose only member is unverified has
       * nobody to tell; failing here would fail a webhook over something no
       * retry can fix.
       */
      this.logger.warn(`No verified billing contact for tenant ${tenantId}`);

      return;
    }

    const template =
      kind === MailKind.TRANSACTIONAL ? 'billing-payment-failed' : 'billing-trial-ending';

    for (const recipient of recipients) {
      const rendered = render(recipient.name);

      try {
        await this.mail.send({
          to: recipient.email,
          template,
          kind,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
      } catch (error) {
        this.logger.warn(
          `Could not mail ${template} to a contact of ${tenantId}: ${(error as Error).message}`,
        );
      }
    }
  }
}

/**
 * A date a merchant reads.
 *
 * 📌 **UTC, and spelled out.** `10/09/2026` means two different days either side
 * of the Atlantic, and a billing deadline is the worst place for that ambiguity.
 */
function formatDeadline(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
