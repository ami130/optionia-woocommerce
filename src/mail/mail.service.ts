import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EmailDelivery } from './entities/email-delivery.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { MailDeliveryError, type MailTransportDriver, type OutgoingMail, type SendResult } from './mailer';

/**
 * Owns every rule that must hold regardless of transport.
 *
 * Suppression checks, delivery records and failure handling live here rather than
 * in a transport, so they cannot differ between SMTP and a future provider. A
 * transport that decided for itself whether to send would make "we never mail a
 * suppressed address" a property of the transport instead of the system.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly transport: MailTransportDriver,
    private readonly from: string,
    @InjectRepository(EmailDelivery)
    private readonly deliveries: Repository<EmailDelivery>,
    @InjectRepository(EmailSuppression)
    private readonly suppressions: Repository<EmailSuppression>,
  ) {}

  /**
   * Send one message.
   *
   * **Never throws for a delivery failure.** Mail is a side effect of a flow that
   * has already succeeded: a registration whose verification email fails is still
   * a registration, and rolling it back because a relay was briefly unreachable
   * would be worse than a resend button. Failures are recorded and returned.
   */
  async send(mail: OutgoingMail): Promise<SendResult> {
    const recipient = normaliseAddress(mail.to);

    if (!recipient) {
      return this.record(mail, recipient, 'failed', '', 'invalid recipient address');
    }

    if (await this.isSuppressed(recipient)) {
      // Not an error. Mailing a known-bad address degrades deliverability for
      // every merchant who *is* reachable, so refusing is the correct outcome.
      this.logger.log(`suppressed: ${mail.template} → ${recipient}`);

      return this.record(mail, recipient, 'suppressed', '', 'address is suppressed');
    }

    try {
      const { providerMessageId } = await this.transport.send(
        { ...mail, to: recipient },
        this.from,
      );

      return this.record(mail, recipient, 'sent', providerMessageId);
    } catch (error) {
      const reason =
        error instanceof MailDeliveryError ? error.message : String((error as Error).message);

      return this.record(mail, recipient, 'failed', '', reason);
    }
  }

  /** True when the address is on the suppression list and not lifted. */
  private async isSuppressed(email: string): Promise<boolean> {
    const row = await this.suppressions.findOne({ where: { email } });

    return row !== null && row.liftedAt === null;
  }

  /**
   * Write the delivery row.
   *
   * Recording must never break the caller: a full disk or a lock timeout while
   * writing history is not a reason to fail a registration whose email was
   * already sent.
   */
  private async record(
    mail: OutgoingMail,
    recipient: string,
    status: string,
    providerMessageId: string,
    error = '',
  ): Promise<SendResult> {
    const sent = status === 'sent';

    try {
      await this.deliveries.save(
        this.deliveries.create({
          tenantId: mail.tenantId ?? null,
          userId: mail.userId ?? null,
          recipient,
          template: mail.template,
          subject: mail.subject,
          status,
          providerMessageId,
          error: error.slice(0, 500),
          attempts: 1,
          sentAt: sent ? new Date() : null,
        }),
      );
    } catch (recordError) {
      this.logger.error(
        `could not record delivery for ${mail.template} → ${recipient}: ` +
          `${(recordError as Error).message}`,
      );
    }

    if (!sent && status === 'failed') {
      this.logger.warn(`mail failed: ${mail.template} → ${recipient}: ${error}`);
    }

    return { sent, providerMessageId, reason: error || undefined };
  }
}

/**
 * Normalise and reject anything that cannot safely become a header.
 *
 * A newline in an address is header injection — the mechanism behind several of
 * the advisories nodemailer 9 fixed. Addresses here can originate from user
 * input (registration, team invitations), so this is a boundary, not a
 * formality.
 */
export function normaliseAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();

  if (/[\r\n\0]/.test(trimmed)) {
    return '';
  }

  // Deliberately permissive beyond that: full RFC 5322 validation rejects
  // addresses that real mail servers accept, and the authoritative test of an
  // address is whether mail to it is delivered.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return '';
  }

  return trimmed;
}
