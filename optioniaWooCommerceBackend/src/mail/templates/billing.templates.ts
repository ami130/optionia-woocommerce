import { button, escapeHtml, layout, type RenderedMail } from './layout';

/**
 * Billing mail (M23.3, ADR-116).
 *
 * 🔴 **ADR-116 promised this and it did not exist.** *"Grace: everything works,
 * with a dashboard banner and dunning mail."* The banner shipped; the mail could
 * not be written, because `src/billing/` had no path from a tenant to a person.
 * A merchant whose card failed got a fourteen-day clock and **no notification**,
 * so the first they learned was when authoring went read-only.
 *
 * ## What these messages never do
 *
 * ⚠️ **No card details, no invoice amounts, no links that authenticate.** Every
 * link below goes to the dashboard, where the merchant signs in as usual — a
 * billing email is a prime phishing target, and one that trains people to click
 * through to a payment form from their inbox is training them to be defrauded.
 *
 * 📌 **Neither message says "your account will be suspended".** ADR-116 is
 * explicit that the storefront never goes dark, and a warning that overstates
 * the consequence is one a merchant learns to distrust.
 */

/**
 * A payment failed, and a clock has started.
 *
 * 🔴 **TRANSACTIONAL, deliberately.** The registry's rule is *"transactional
 * when the merchant needs it to use their account"* — after the grace period
 * authoring goes read-only, so they do. It also means an `UNSUBSCRIBE`
 * suppression does not silence it: someone who opted out of product tips must
 * still hear that their card was declined.
 */
export function paymentFailed(name: string, graceEndsOn: string, url: string): RenderedMail {
  const greeting = name.trim() ? `Hi ${name.trim()},` : 'Hi,';

  return {
    subject: 'Your payment did not go through',
    text: [
      greeting,
      '',
      "We could not take payment for your Optionia subscription. This is usually an expired card rather than anything you have done.",
      '',
      `Your storefront keeps working normally. If the payment is not settled by ${graceEndsOn}, editing your option sets will pause until it is — what you have already published stays live.`,
      '',
      'Update your payment method here:',
      '',
      url,
      '',
      'If you have already fixed this, you can ignore this message.',
    ].join('\n'),
    html: layout(
      'Your payment did not go through',
      `<p>${escapeHtml(greeting)}</p>` +
        '<p>We could not take payment for your Optionia subscription. This is usually an expired card rather than anything you have done.</p>' +
        `<p><strong>Your storefront keeps working normally.</strong> If the payment is not settled by ${escapeHtml(graceEndsOn)}, editing your option sets will pause until it is — what you have already published stays live.</p>` +
        button(url, 'Update payment method') +
        '<p style="font-size:13px;color:#6b6b6b">If you have already fixed this, you can ignore this message.</p>',
    ),
  };
}

/**
 * A trial is ending in a few days.
 *
 * 📌 **LIFECYCLE, and that is the right call.** The merchant does not need this
 * to *use* their account — nothing breaks when a trial ends, they simply stop
 * being on a trial. The registry's own line covers it: *"onboarding, tips and
 * announcements are LIFECYCLE however urgent they feel."*
 *
 * ⚠️ Which also means an unsubscribed merchant will not receive it, and that is
 * correct: they asked not to be marketed to, and this is a nudge.
 */
export function trialEnding(name: string, endsOn: string, url: string): RenderedMail {
  const greeting = name.trim() ? `Hi ${name.trim()},` : 'Hi,';

  return {
    subject: 'Your Optionia trial ends soon',
    text: [
      greeting,
      '',
      `Your trial ends on ${endsOn}. Add a payment method before then to keep everything running without interruption.`,
      '',
      url,
      '',
      'If you would rather not continue, you do not need to do anything.',
    ].join('\n'),
    html: layout(
      'Your Optionia trial ends soon',
      `<p>${escapeHtml(greeting)}</p>` +
        `<p>Your trial ends on ${escapeHtml(endsOn)}. Add a payment method before then to keep everything running without interruption.</p>` +
        button(url, 'Choose a plan') +
        '<p style="font-size:13px;color:#6b6b6b">If you would rather not continue, you do not need to do anything.</p>',
    ),
  };
}
