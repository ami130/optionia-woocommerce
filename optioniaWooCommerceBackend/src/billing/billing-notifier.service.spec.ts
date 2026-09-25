import { MailKind, TenantRole } from '../common/database/enums';
import type { MailService } from '../mail/mail.service';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import type { BillingContact, BillingContactsService } from './billing-contacts.service';
import { BillingNotifierService } from './billing-notifier.service';

/**
 * ADR-116's dunning mail (M23.3).
 *
 * 🔴 **The promise was made and not kept.** *"Grace: everything works, with a
 * dashboard banner and dunning mail."* The banner shipped in F113; this is the
 * other half, and it could not be written until F115 gave billing a way to
 * address a person.
 */
describe('BillingNotifierService', () => {
  const saved = { ...process.env };

  /** `loadConfig` validates the whole environment, so a partial one fails on JWT_SECRET. */
  const VALID_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'optionia_woo_test',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    DB_SSL: 'false',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:3000',
    APP_URL: 'https://dash.example.test',
  };

  beforeEach(() => {
    /* 📌 Overlaid, never wiped (K4): emptying process.env breaks sibling suites. */
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    Object.assign(process.env, saved);
  });

  function build(contacts: BillingContact[]) {
    const send = jest.fn(async () => ({ status: 'sent' }));

    const service = new BillingNotifierService(
      { forTenant: jest.fn(async () => contacts) } as unknown as BillingContactsService,
      { send } as unknown as MailService,
    );

    return { service, send };
  }

  const owner: BillingContact = {
    email: 'owner@example.test',
    name: 'Ana',
    role: TenantRole.OWNER,
  };

  const finance: BillingContact = {
    email: 'finance@example.test',
    name: 'Sam',
    role: TenantRole.BILLING,
  };

  function subscription(over: Partial<Subscription> = {}): Subscription {
    return {
      tenantId: 'tenant_1',
      graceEndsAt: new Date('2026-10-09T00:00:00.000Z'),
      trialEndsAt: null,
      ...over,
    } as Subscription;
  }

  describe('a failed payment', () => {
    /**
     * 🔴 **TRANSACTIONAL**, so an `UNSUBSCRIBE` suppression does not silence it.
     * A merchant who opted out of product tips must still hear their card was
     * declined — after the grace period, authoring goes read-only.
     */
    it('sends the dunning template as transactional mail', async () => {
      const { service, send } = build([owner]);

      await service.paymentFailed(subscription());

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@example.test',
          template: 'billing-payment-failed',
          kind: MailKind.TRANSACTIONAL,
        }),
      );
    });

    /** 📌 Owner and billing-role member both hear it (F115). */
    it('mails every billing contact', async () => {
      const { service, send } = build([owner, finance]);

      await service.paymentFailed(subscription());

      expect(send).toHaveBeenCalledTimes(2);
    });

    /**
     * 🔴 **One bad address must not deny the news to the person who can fix the
     * card.** A `Promise.all` would let a single failure take the rest down.
     */
    it('keeps going when one recipient fails', async () => {
      const { service, send } = build([owner, finance]);
      send.mockRejectedValueOnce(new Error('bad address'));

      await expect(service.paymentFailed(subscription())).resolves.toBeUndefined();

      expect(send).toHaveBeenCalledTimes(2);
    });

    /**
     * ⚠️ **"Act by <nothing>" is worse than no message.** The caller only
     * reaches here having just set the deadline, but a notice without one
     * cannot be acted on.
     */
    it('sends nothing when there is no grace deadline', async () => {
      const { service, send } = build([owner]);

      await service.paymentFailed(subscription({ graceEndsAt: null }));

      expect(send).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ **No verified contact is not an error.** Failing here would fail a
     * webhook over something no retry can fix.
     */
    it('does not throw when nobody can be reached', async () => {
      const { service, send } = build([]);

      await expect(service.paymentFailed(subscription())).resolves.toBeUndefined();

      expect(send).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **The date is spelled out in UTC.** `10/09/2026` means two different
     * days either side of the Atlantic, and a billing deadline is the worst
     * place for that ambiguity.
     */
    it('writes the deadline unambiguously', async () => {
      const { service, send } = build([owner]);

      await service.paymentFailed(subscription());

      const [[mail]] = send.mock.calls as unknown as [[{ text: string }]];

      expect(mail.text).toContain('9 October 2026');
      expect(mail.text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });

    /**
     * ⚠️ **The link goes to the dashboard, never to a payment form.** A billing
     * email is a prime phishing target, and one that trains merchants to reach
     * a payment page from their inbox is training them to be defrauded.
     */
    it('links to the dashboard', async () => {
      const { service, send } = build([owner]);

      await service.paymentFailed(subscription());

      const [[mail]] = send.mock.calls as unknown as [[{ text: string }]];

      expect(mail.text).toContain('https://dash.example.test/subscription');
    });
  });

  describe('a trial ending', () => {
    /**
     * 📌 **LIFECYCLE, and that is the right call.** Nothing breaks when a trial
     * ends — the merchant simply stops being on one. Which also means an
     * unsubscribed merchant will not receive it, correctly: they asked not to
     * be nudged.
     */
    it('sends the trial notice as lifecycle mail', async () => {
      const { service, send } = build([owner]);

      await service.trialEnding(
        subscription({ trialEndsAt: new Date('2026-10-09T00:00:00.000Z') }),
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'billing-trial-ending',
          kind: MailKind.LIFECYCLE,
        }),
      );
    });

    it('sends nothing when there is no trial', async () => {
      const { service, send } = build([owner]);

      await service.trialEnding(subscription({ trialEndsAt: null }));

      expect(send).not.toHaveBeenCalled();
    });
  });
});
