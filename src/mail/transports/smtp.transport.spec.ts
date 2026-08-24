import { Logger } from '@nestjs/common';

import type { AppConfig } from '../../config/env';
import { MailDeliveryError, type OutgoingMail } from '../mailer';
import { SmtpTransport } from './smtp.transport';

/**
 * The transport that will actually send mail.
 *
 * It had never been constructed by a test. That matters more than the coverage
 * number: this is the seam where the production provider replaces SMTP (D4), and
 * a seam with no tests cannot be swapped confidently.
 *
 * No live relay is involved. Port 1 on loopback is closed, which exercises the
 * real failure path rather than a mocked one — the same code that runs when a
 * relay is unreachable in production.
 */
describe('SmtpTransport', () => {
  function config(smtp: Record<string, unknown> | null): AppConfig {
    return { mail: { transport: 'smtp', from: 'Optionia <no-reply@example.com>', smtp } } as unknown as AppConfig;
  }

  const working = {
    host: 'smtp.example.com',
    port: 587,
    user: 'sender@example.com',
    password: 'app-password',
    secure: false,
  };

  const mail: OutgoingMail = {
    to: 'merchant@example.com',
    subject: 'Verify your email',
    text: 'plain',
    html: '<p>html</p>',
    template: 'verify-email',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('identifies itself as the smtp transport', () => {
    expect(new SmtpTransport(config(working)).name).toBe('smtp');
  });

  /**
   * Unreachable through the module, which only constructs this when SMTP is
   * configured. Explicit anyway: a null would otherwise surface as an unrelated
   * TypeError inside nodemailer at the first send, long after the mistake.
   */
  it('refuses to construct without SMTP configuration', () => {
    expect(() => new SmtpTransport(config(null))).toThrow(/requires SMTP configuration/);
  });

  describe('when the relay is unreachable', () => {
    // Port 1 is closed on every machine this runs on.
    const unreachable = { ...working, host: '127.0.0.1', port: 1 };

    it('wraps the failure in a MailDeliveryError', async () => {
      const transport = new SmtpTransport(config(unreachable));

      await expect(transport.send(mail, 'x@example.com')).rejects.toThrow(MailDeliveryError);
    }, 30_000);

    /**
     * `MailService` records which transport failed on the delivery row, so the
     * error has to carry it — otherwise support cannot tell an SMTP outage from a
     * provider outage after the transport is swapped.
     */
    it('names the transport and preserves the original cause', async () => {
      const transport = new SmtpTransport(config(unreachable));

      await transport.send(mail, 'x@example.com').then(
        () => {
          throw new Error('send to a closed port should not resolve');
        },
        (error: MailDeliveryError) => {
          expect(error.transport).toBe('smtp');
          expect(error.cause).toBeDefined();
          expect(error.message).toContain('SMTP delivery failed');
        },
      );
    }, 30_000);
  });
});
