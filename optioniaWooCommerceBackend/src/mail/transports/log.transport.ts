import { Injectable, Logger } from '@nestjs/common';

import type { MailTransportDriver, OutgoingMail } from '../mailer';

/**
 * Writes the message to the log and sends nothing.
 *
 * The default when no SMTP host is configured, which covers a fresh checkout and
 * the whole test suite. The alternative — requiring credentials everywhere —
 * means either checked-in secrets or a suite that cannot run, and the first
 * person to type `npm test` mailing a real stranger.
 *
 * `loadConfig` refuses this transport in production, because a verification email
 * written to a log is indistinguishable from a working system until a merchant
 * reports never receiving one.
 */
@Injectable()
export class LogTransport implements MailTransportDriver {
  readonly name = 'log';

  private readonly logger = new Logger(LogTransport.name);

  send(mail: OutgoingMail, from: string): Promise<{ providerMessageId: string }> {
    // The body is logged at debug so a developer can click the verification link
    // out of the terminal, which is the whole point of this transport. It stays
    // out of info because those links are single-use credentials.
    this.logger.log(`mail[${mail.template}] → ${mail.to}: ${mail.subject}`);
    this.logger.debug(`from: ${from}\n${mail.text}`);

    return Promise.resolve({ providerMessageId: '' });
  }
}
