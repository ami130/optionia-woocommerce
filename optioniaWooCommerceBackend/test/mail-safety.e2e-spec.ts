import { loadConfig, MailTransport } from '../src/config/env';

/**
 * No mail leaves this machine during an e2e run (F78).
 *
 * ## Why this suite exists at all
 *
 * 🔴 **F78 already happened.** With `SMTP_HOST` populated in `.env`, every e2e
 * run sent real verification mail to addresses like `e2e-…@optionia.test`, and
 * every one bounced *"Address not found"* into the owner's real inbox. The
 * suite creates users constantly — that is its job — so the blast radius is the
 * whole suite, not a stray message.
 *
 * ⚠️ **The protection was a person remembering to blank `SMTP_HOST`**, and this
 * repository described that as a guard. It was not one: `setup-e2e.ts` pinned
 * `DB_NAME` and the throttle limits and said nothing about mail. The gap was
 * found on 2026-09-28, when the owner put a real host back in `.env`.
 *
 * 📌 **This is the cheapest possible assertion and it is the whole point.** A
 * developer must be able to keep working SMTP credentials in `.env` — for
 * testing delivery by hand — without that decision silently arming the test
 * suite against their own inbox.
 */
describe('mail safety (e2e)', () => {
  /**
   * 🔴 **Asserted on the CONFIG, not on `process.env`.** Checking the variable
   * would prove only that something blanked a string; this proves the
   * application actually resolves to a transport that cannot reach the
   * network, which is the property that matters.
   */
  it('resolves to the log transport however `.env` is configured', () => {
    expect(loadConfig().mail.transport).toBe(MailTransport.LOG);
  });

  /**
   * ⚠️ **And the host is empty, which is what forces the choice above.**
   * `loadMailConfig()` reads `SMTP_HOST` alone to pick a transport — the user,
   * password and port are ignored without it — so this is the single value
   * that decides whether the suite can send.
   */
  it('runs with no SMTP host, whatever the developer keeps in .env', () => {
    expect(process.env.SMTP_HOST ?? '').toBe('');
  });

  /**
   * 📌 **Credentials are deliberately NOT blanked.** Without a host they are
   * never used, and clearing them would hide a misconfiguration rather than
   * prevent a send — the guard is the host, and only the host.
   */
  it('leaves the credentials alone, because the host is what disarms it', () => {
    const config = loadConfig();

    expect(config.mail.smtp).toBeNull();
  });
});
