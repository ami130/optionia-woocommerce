import { MailKind } from '../../common/database/enums';
import { Logger } from '@nestjs/common';

import { LogTransport } from './log.transport';
import type { OutgoingMail } from '../mailer';

/**
 * The transport the whole test suite runs on.
 *
 * It had no test of its own, which meant a regression here would be silent
 * everywhere — every other suite would keep passing while no message was
 * recorded, because nothing asserted what this does.
 */
describe('LogTransport', () => {
  const mail: OutgoingMail = {
    to: 'merchant@example.com',
    subject: 'Verify your email',
    text: 'Visit https://app.example.com/verify?t=abc',
    html: '<p>html</p>',
    template: 'verify-email',
    kind: MailKind.TRANSACTIONAL,
  };

  let logged: string[];
  let debugged: string[];

  beforeEach(() => {
    logged = [];
    debugged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => void logged.push(String(m)));
    jest.spyOn(Logger.prototype, 'debug').mockImplementation((m) => void debugged.push(String(m)));
  });

  afterEach(() => jest.restoreAllMocks());

  it('identifies itself as the log transport', () => {
    expect(new LogTransport().name).toBe('log');
  });

  /**
   * `MailService` records `providerMessageId` on every delivery row. SMTP has one
   * and this does not, so it must return a string rather than undefined — a null
   * here becomes a NOT NULL violation at insert.
   */
  it('returns an empty provider id rather than undefined', async () => {
    const result = await new LogTransport().send(mail, 'Optionia <no-reply@example.com>');

    expect(result.providerMessageId).toBe('');
  });

  it('logs the template and recipient so a send is traceable', async () => {
    await new LogTransport().send(mail, 'Optionia <no-reply@example.com>');

    expect(logged.join('\n')).toContain('verify-email');
    expect(logged.join('\n')).toContain('merchant@example.com');
  });

  /**
   * The body carries single-use credentials — a verification link is one. It
   * belongs at debug, where a developer can click it out of the terminal, and
   * not at the level that ships to a log aggregator by default.
   */
  it('keeps the body out of the info-level line', async () => {
    await new LogTransport().send(mail, 'Optionia <no-reply@example.com>');

    expect(logged.join('\n')).not.toContain('verify?t=abc');
    expect(debugged.join('\n')).toContain('verify?t=abc');
  });

  /** Sending must not require a database or a network, or the suite cannot run. */
  it('resolves without any external dependency', async () => {
    await expect(
      new LogTransport().send(mail, 'Optionia <no-reply@example.com>'),
    ).resolves.toEqual({ providerMessageId: '' });
  });
});
