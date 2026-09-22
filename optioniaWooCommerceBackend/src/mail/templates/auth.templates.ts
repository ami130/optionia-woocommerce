import { button, escapeHtml, layout, type RenderedMail } from './layout';

/**
 * The AUTH group from M6.0.
 *
 * Every one is plain-text *and* HTML, because a verification link that only
 * renders in an HTML client is a locked-out merchant. The text version is the
 * one that always works; the HTML is the courtesy.
 *
 * **Never in these messages:** a password, a token that does not expire, or a
 * link that authenticates without being single-use. Each link below is one-shot
 * and time-limited, and says so — a merchant who understands why a link stopped
 * working does not file a support ticket.
 */

export function verifyEmail(name: string, url: string, hours: number): RenderedMail {
  const greeting = name.trim() ? `Hi ${name.trim()},` : 'Hi,';

  return {
    subject: 'Verify your email address',
    text: [
      greeting,
      '',
      'Confirm your email address to finish setting up your Optionia account:',
      '',
      url,
      '',
      `This link works once and expires in ${hours} hours.`,
      '',
      "If you didn't create an account, you can ignore this message.",
    ].join('\n'),
    html: layout(
      'Verify your email address',
      `<p>${escapeHtml(greeting)}</p>` +
        '<p>Confirm your email address to finish setting up your Optionia account.</p>' +
        button(url, 'Verify email') +
        `<p style="font-size:13px;color:#6b6b6b">This link works once and expires in ${hours} hours. ` +
        "If you didn't create an account, you can ignore this message.</p>",
    ),
  };
}

export function passwordReset(url: string, minutes: number): RenderedMail {
  return {
    subject: 'Reset your password',
    text: [
      'Someone asked to reset the password for this Optionia account.',
      '',
      url,
      '',
      `This link works once and expires in ${minutes} minutes.`,
      '',
      "If it wasn't you, no action is needed — your password has not changed.",
    ].join('\n'),
    html: layout(
      'Reset your password',
      '<p>Someone asked to reset the password for this Optionia account.</p>' +
        button(url, 'Reset password') +
        `<p style="font-size:13px;color:#6b6b6b">This link works once and expires in ${minutes} minutes. ` +
        "If it wasn't you, no action is needed — your password has not changed.</p>",
    ),
  };
}

/**
 * Sent *after* a successful change, to the address that owns the account.
 *
 * This is the message that tells a victim their account was taken over, so it
 * names when and from where. It is not optional politeness — without it, a
 * successful reset by an attacker is completely silent.
 */
export function passwordChanged(when: Date, ip: string): RenderedMail {
  const at = when.toISOString().replace('T', ' ').slice(0, 19);
  const where = ip.trim() ? ` from ${ip.trim()}` : '';

  return {
    subject: 'Your password was changed',
    text: [
      `The password for your Optionia account was changed on ${at} UTC${where}.`,
      '',
      "If this wasn't you, reset your password immediately and contact support —",
      'someone else may have access to your account.',
    ].join('\n'),
    html: layout(
      'Your password was changed',
      `<p>The password for your Optionia account was changed on ` +
        `<strong>${escapeHtml(at)} UTC</strong>${escapeHtml(where)}.</p>` +
        "<p style=\"font-size:13px;color:#6b6b6b\">If this wasn't you, reset your password " +
        'immediately and contact support — someone else may have access to your account.</p>',
    ),
  };
}
