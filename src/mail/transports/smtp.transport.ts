import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import type { AppConfig } from '../../config/env';
import { MailDeliveryError, type MailTransportDriver, type OutgoingMail } from '../mailer';

/**
 * Sends over authenticated SMTP.
 *
 * Development and the closed beta only. SMTP reports handoff to the relay rather
 * than delivery to an inbox and offers no webhook, so bounce and complaint
 * handling cannot work — the production provider is still open (D4).
 *
 * **The transporter is created once and reused.** Nodemailer pools connections,
 * and building one per message means a TLS handshake and an AUTH round-trip for
 * every email — which under a burst of invitations is what gets a sender
 * rate-limited by its own relay.
 */
@Injectable()
export class SmtpTransport implements MailTransportDriver {
  readonly name = 'smtp';

  private readonly logger = new Logger(SmtpTransport.name);
  private readonly transporter: Transporter;

  constructor(config: AppConfig) {
    const smtp = config.mail.smtp;

    if (!smtp) {
      // Unreachable through the module, which only constructs this when smtp is
      // present. Explicit anyway: a null here would surface as an unrelated
      // TypeError inside nodemailer at first send.
      throw new Error('SmtpTransport requires SMTP configuration.');
    }

    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.password },
      pool: true,
      maxConnections: 3,
      // A relay that stops responding must not hold a request open. The auth
      // flow that triggered this send is waiting on it.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(mail: OutgoingMail, from: string): Promise<{ providerMessageId: string }> {
    try {
      const info = await this.transporter.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // Nodemailer 9 fixed several CRLF injection paths; these two remove the
        // remaining classes outright. Nothing here needs to read a file or fetch
        // a URL while assembling a message, so allowing it only widens what a
        // crafted template value could reach.
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      return { providerMessageId: String(info.messageId ?? '') };
    } catch (error) {
      this.logger.warn(`SMTP send failed for ${mail.template}: ${(error as Error).message}`);

      throw new MailDeliveryError(
        `SMTP delivery failed: ${(error as Error).message}`,
        this.name,
        error,
      );
    }
  }
}
