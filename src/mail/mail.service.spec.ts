import { MailService, normaliseAddress } from './mail.service';
import { MailDeliveryError, type MailTransportDriver, type OutgoingMail } from './mailer';

/**
 * The rules that must hold whatever the transport is.
 *
 * They live in `MailService` precisely so they cannot differ between SMTP and a
 * future provider, and these tests are what hold that line — a transport-level
 * suppression check would pass its own tests while leaving the guarantee false
 * for every other transport.
 */
describe('MailService', () => {
  function build(overrides: {
    transport?: Partial<MailTransportDriver>;
    suppression?: { liftedAt: Date | null } | null;
    onSave?: (row: Record<string, unknown>) => void;
    saveThrows?: boolean;
  }) {
    const sent: OutgoingMail[] = [];
    const rows: Array<Record<string, unknown>> = [];

    const transport: MailTransportDriver = {
      name: 'fake',
      send: (mail) => {
        sent.push(mail);

        return Promise.resolve({ providerMessageId: 'fake-1' });
      },
      ...overrides.transport,
    };

    const deliveries = {
      create: (row: Record<string, unknown>) => row,
      save: (row: Record<string, unknown>) => {
        if (overrides.saveThrows) {
          return Promise.reject(new Error('disk full'));
        }

        rows.push(row);
        overrides.onSave?.(row);

        return Promise.resolve(row);
      },
    };

    const suppressions = {
      findOne: () => Promise.resolve(overrides.suppression ?? null),
    };

    const service = new MailService(
      transport,
      'Optionia <no-reply@example.com>',
      deliveries as never,
      suppressions as never,
    );

    return { service, sent, rows };
  }

  const mail: OutgoingMail = {
    to: 'merchant@example.com',
    subject: 'Verify your email',
    text: 'plain',
    html: '<p>html</p>',
    template: 'verify-email',
  };

  it('sends and records the delivery', async () => {
    const { service, sent, rows } = build({});

    const result = await service.send(mail);

    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', template: 'verify-email' });
    expect(rows[0].sentAt).toBeInstanceOf(Date);
  });

  describe('suppression', () => {
    /**
     * Mailing a known-bad address degrades deliverability for every merchant who
     * *is* reachable, because providers score a sender on bounce rates. Refusing
     * is the correct outcome, not a failure.
     */
    it('refuses to send to a suppressed address', async () => {
      const { service, sent, rows } = build({ suppression: { liftedAt: null } });

      const result = await service.send(mail);

      expect(result.sent).toBe(false);
      expect(sent).toHaveLength(0);
      expect(rows[0]).toMatchObject({ status: 'suppressed' });
    });

    it('sends again once a suppression is lifted', async () => {
      const { service, sent } = build({ suppression: { liftedAt: new Date() } });

      const result = await service.send(mail);

      expect(result.sent).toBe(true);
      expect(sent).toHaveLength(1);
    });
  });

  describe('recipient safety', () => {
    /**
     * A newline in an address is header injection — the mechanism behind several
     * advisories nodemailer 9 fixed. Addresses reach here from registration and
     * team invitations, so this is a boundary rather than a formality.
     */
    it('refuses an address containing a newline', async () => {
      const { service, sent } = build({});

      const result = await service.send({
        ...mail,
        to: 'victim@example.com\nBcc: attacker@evil.test',
      });

      expect(result.sent).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('refuses a carriage return and a null byte', () => {
      expect(normaliseAddress('a@b.com\rBcc: x@y.z')).toBe('');
      expect(normaliseAddress('a@b.com\0')).toBe('');
    });

    it('lowercases and trims, so one address is one identity', () => {
      expect(normaliseAddress('  Merchant@Example.COM ')).toBe('merchant@example.com');
    });

    it('rejects text that is not an address', () => {
      expect(normaliseAddress('not-an-address')).toBe('');
      expect(normaliseAddress('two@at@signs.com')).toBe('');
      expect(normaliseAddress('')).toBe('');
    });
  });

  describe('failure handling', () => {
    /**
     * Mail is a side effect of a flow that already succeeded. A registration
     * whose verification email fails is still a registration; rolling it back
     * because a relay was briefly unreachable is worse than a resend button.
     */
    it('does not throw when the transport fails', async () => {
      const { service, rows } = build({
        transport: {
          send: () => Promise.reject(new MailDeliveryError('relay refused', 'fake')),
        },
      });

      const result = await service.send(mail);

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('relay refused');
      expect(rows[0]).toMatchObject({ status: 'failed' });
    });

    /**
     * Failing to write history must not fail the caller either — a lock timeout
     * while recording is not a reason to break a registration whose email was
     * already sent.
     */
    it('survives a failure to record the delivery', async () => {
      const { service } = build({ saveThrows: true });

      await expect(service.send(mail)).resolves.toMatchObject({ sent: true });
    });

    it('truncates a long transport error to fit the column', async () => {
      const { service, rows } = build({
        transport: { send: () => Promise.reject(new Error('x'.repeat(900))) },
      });

      await service.send(mail);

      expect(String(rows[0].error).length).toBeLessThanOrEqual(500);
    });
  });
});
