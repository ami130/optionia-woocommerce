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

    await this.notify(subscription.tenantId, (name) =>
      paymentFailed(name, formatDeadline(deadline), `${loadConfig().appUrl}/subscription`),
    );
  }

  /** A trial ends in a few days and no payment method is on file. */
  async trialEnding(subscription: Subscription): Promise<void> {
    const endsAt = subscription.trialEndsAt;

    if (endsAt === null) {
      return;
    }

    await this.notify(
      subscription.tenantId,
      (name) => trialEnding(name, formatDeadline(endsAt), `${loadConfig().appUrl}/subscription`),
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
