import { passwordChanged, passwordReset, verifyEmail } from './auth.templates';
import { escapeHtml } from './layout';

describe('auth templates', () => {
  /**
   * A verification link that only renders in an HTML client is a locked-out
   * merchant. Every template ships both, and the text version is the one that
   * always works.
   */
  it('renders both formats for every template', () => {
    const rendered = [
      verifyEmail('Sam', 'https://app.example.com/verify?t=abc', 24),
      passwordReset('https://app.example.com/reset?t=abc', 30),
      passwordChanged(new Date('2026-01-02T03:04:05Z'), '203.0.113.10'),
    ];

    rendered.forEach((mail) => {
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.text.length).toBeGreaterThan(0);
      expect(mail.html).toContain('<div');
    });
  });

  /**
   * The link must survive in the plain-text body. A client that strips HTML
   * leaves the text part as the only way to complete the flow.
   */
  it('puts the link in the text body, not only the HTML', () => {
    const url = 'https://app.example.com/verify?t=abc123';

    expect(verifyEmail('Sam', url, 24).text).toContain(url);
    expect(passwordReset(url, 30).text).toContain(url);
  });

  /**
   * Names arrive from registration input. Without escaping, a merchant called
   * `<script>` decides what the HTML of our email is.
   */
  it('escapes a name that contains markup', () => {
    const mail = verifyEmail('<script>alert(1)</script>', 'https://x.test/v', 24);

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('escapes every character that could break out of HTML', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  /** A URL carrying an unescaped quote would terminate the href attribute. */
  it('escapes a quote inside a URL', () => {
    const mail = verifyEmail('Sam', 'https://x.test/v?t=a"onmouseover="alert(1)', 24);

    expect(mail.html).not.toContain('"onmouseover="');
    expect(mail.html).toContain('&quot;');
  });

  it('handles a missing name without an awkward greeting', () => {
    expect(verifyEmail('', 'https://x.test/v', 24).text).toMatch(/^Hi,/);
    expect(verifyEmail('   ', 'https://x.test/v', 24).text).toMatch(/^Hi,/);
  });

  /**
   * Expiry is stated because a merchant who understands why a link stopped
   * working does not file a support ticket.
   */
  it('states the expiry in both formats', () => {
    const verify = verifyEmail('Sam', 'https://x.test/v', 24);
    expect(verify.text).toContain('24 hours');
    expect(verify.html).toContain('24 hours');

    const reset = passwordReset('https://x.test/r', 30);
    expect(reset.text).toContain('30 minutes');
    expect(reset.html).toContain('30 minutes');
  });

  /**
   * This message is how a victim learns of a takeover, so it must carry both
   * when and where.
   */
  it('names the time and origin of a password change', () => {
    const mail = passwordChanged(new Date('2026-01-02T03:04:05Z'), '203.0.113.10');

    expect(mail.text).toContain('2026-01-02 03:04:05');
    expect(mail.text).toContain('203.0.113.10');
    expect(mail.text).toMatch(/wasn't you/);
  });

  it('reads correctly when the origin IP is unknown', () => {
    const mail = passwordChanged(new Date('2026-01-02T03:04:05Z'), '');

    expect(mail.text).toContain('2026-01-02 03:04:05');
    expect(mail.text).not.toContain('from  ');
  });

  /** No template may carry a credential — M6.0 states this outright. */
  it('never contains a password or a raw token field', () => {
    const all = [
      verifyEmail('Sam', 'https://x.test/v?t=abc', 24),
      passwordReset('https://x.test/r?t=abc', 30),
      passwordChanged(new Date(), '1.2.3.4'),
    ];

    all.forEach((mail) => {
      expect(mail.text.toLowerCase()).not.toMatch(/your password is|password:/);
      expect(mail.html.toLowerCase()).not.toMatch(/your password is|password:/);
    });
  });
});
