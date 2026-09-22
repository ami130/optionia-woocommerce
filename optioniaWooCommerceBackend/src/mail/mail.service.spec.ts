import {
  MailKind,
  SuppressionReason,
  TRANSACTIONAL_TEMPLATES,
} from '../common/database/enums';
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
    suppression?: { liftedAt: Date | null; reason?: string } | null;
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
    kind: MailKind.TRANSACTIONAL,
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

    /**
     * 🔴 **An unsubscribe used to silence a password reset.**
     *
     * Every mail was refused for a suppressed address whatever the reason, so a
     * merchant who opted out of onboarding email would stop receiving
     * verification links and resets — locking themselves out of their own
     * account by clicking unsubscribe in a marketing message. Nothing writes an
     * `unsubscribe` row yet, which is the only reason it had not happened.
     */
    describe('an unsubscribe silences nudges, not account mail', () => {
      const unsubscribed = { liftedAt: null, reason: SuppressionReason.UNSUBSCRIBE };

      it('still sends transactional mail', async () => {
        const { service, sent } = build({ suppression: unsubscribed });

        const result = await service.send({ ...mail, kind: MailKind.TRANSACTIONAL });

        expect(result.sent).toBe(true);
        expect(sent).toHaveLength(1);
      });

      it('refuses lifecycle mail', async () => {
        const { service, sent, rows } = build({ suppression: unsubscribed });

        /*
         * ⚠️ A real lifecycle template, not `mail`'s transactional one: the
         * allow-list refuses a mismatch in **both** directions, so reusing the
         * default here would fail for the wrong reason.
         */
        const result = await service.send({
          ...mail,
          template: 'nudge-stalled-before-connect',
          kind: MailKind.LIFECYCLE,
        });

        expect(result.sent).toBe(false);
        expect(sent).toHaveLength(0);
        expect(rows[0]).toMatchObject({ status: 'suppressed' });
      });
    });

    /**
     * ⚠️ **Deliverability suppressions silence everything, including account
     * mail.** A hard-bounced address does not work, so a password reset would not
     * arrive either — and sending to it damages delivery for every merchant who
     * *is* reachable. `manual` is read the same way: support's "stop mailing
     * this" means all of it.
     */
    it.each([
      SuppressionReason.HARD_BOUNCE,
      SuppressionReason.COMPLAINT,
      SuppressionReason.MANUAL,
    ])('refuses even transactional mail for a %s', async (reason) => {
      const { service, sent } = build({ suppression: { liftedAt: null, reason } });

      const result = await service.send({ ...mail, kind: MailKind.TRANSACTIONAL });

      expect(result.sent).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });

  /**
   * 🔴 **A nudge must not be able to call itself transactional.**
   *
   * `kind` decides whether an unsubscribe silences a message and is declared by
   * the caller, so without this a lifecycle mail could opt out of opt-outs — the
   * inverse of the defect `MailKind` exists to fix, and invisible until a
   * merchant complained that unsubscribing did nothing.
   */
  describe('the transactional allow-list', () => {
    it.each(TRANSACTIONAL_TEMPLATES)('accepts %s as transactional', async (template) => {
      const { service, sent } = build({});

      const result = await service.send({
        ...mail,
        template,
        kind: MailKind.TRANSACTIONAL,
      });

      expect(result.sent).toBe(true);
      expect(sent).toHaveLength(1);
    });

    it('refuses a template that is not on the list', async () => {
      const { service, sent } = build({});

      await expect(
        service.send({ ...mail, template: 'nudge-stalled-before-connect', kind: MailKind.TRANSACTIONAL }),
      ).rejects.toThrow(/is lifecycle mail, sent as transactional/);

      /* ⚠️ Nothing sent: the refusal happens before the transport is reached. */
      expect(sent).toHaveLength(0);
    });

    /** The same template as lifecycle mail is fine — that is the honest kind. */
    it('accepts an unlisted template as lifecycle mail', async () => {
      const { service, sent } = build({});

      const result = await service.send({
        ...mail,
        template: 'nudge-stalled-before-connect',
        kind: MailKind.LIFECYCLE,
      });

      expect(result.sent).toBe(true);
      expect(sent).toHaveLength(1);
    });

    /**
     * 🔴 **The mirror image, and the one the first version of this guard let
     * through.** It refused a nudge claiming transactional and permitted
     * `password-reset` declared `LIFECYCLE` — which an unsubscribe then silences,
     * locking a merchant out of their own account. Same outcome as the defect
     * `MailKind` exists to prevent, reached by a one-word mistake at a call site.
     */
    it.each(TRANSACTIONAL_TEMPLATES)('refuses %s sent as lifecycle mail', async (template) => {
      const { service, sent } = build({});

      await expect(
        service.send({ ...mail, template, kind: MailKind.LIFECYCLE }),
      ).rejects.toThrow(/is transactional mail, sent as lifecycle/);

      expect(sent).toHaveLength(0);
    });

    /**
     * ⚠️ **Refused, not silently corrected.** Sending it under the right kind
     * would hide a call site that disagrees with the allow-list, and the next
     * edit there would be made against a belief the code had quietly overruled.
     */
    it('does not quietly send a mismatched message under the correct kind', async () => {
      const { service, sent, rows } = build({});

      await expect(
        service.send({ ...mail, template: 'password-reset', kind: MailKind.LIFECYCLE }),
      ).rejects.toThrow();

      expect(sent).toHaveLength(0);
      expect(rows).toHaveLength(0);
    });

    /**
     * 📌 The list must name every template the code actually sends as
     * transactional, or a real auth mail throws at send time.
     */
    it('covers every transactional mail this API sends', () => {
      expect([...TRANSACTIONAL_TEMPLATES].sort()).toEqual([
        'password-changed',
        'password-reset',
        'verify-email',
      ]);
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
