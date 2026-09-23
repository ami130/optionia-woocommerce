import { cleanupPreviousRuns, residue } from './cleanup';
import { apiSmtpHost } from './fixtures';
import { checkServices, SERVICES } from './services';

/**
 * Refuse to run rather than fail confusingly.
 *
 * The canonical flow spans three services, and a failure in step nine that was
 * really "the API was never started" costs far more to diagnose than it costs to
 * check first. Every check names the command that fixes it.
 */
/**
 * Every origin must be local.
 *
 * 🔴 The suite runs with `ignoreHTTPSErrors`, because Studio's certificate is
 * self-signed. That is only defensible while every origin is on this machine:
 * with no network path between the browser and the services, there is nothing
 * to substitute a certificate. Pointed at a remote stack, the same setting would
 * silently accept an intercepted one.
 *
 * So the constraint that makes it safe is **enforced here** rather than assumed
 * in a comment. `.local` is included because that is what Studio's HTTPS
 * requires, and it resolves through the loopback interface.
 */
function assertLocal(): void {
  const remote = Object.entries(SERVICES).filter(([, url]) => {
    const { hostname } = new URL(url);

    return !(
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local')
    );
  });

  if (remote.length > 0) {
    const named = remote.map(([name, url]) => `${name} (${url})`).join(', ');

    throw new Error(
      `This suite runs with ignoreHTTPSErrors, which is only safe against local ` +
        `origins — and these are not local: ${named}.\n` +
        `Remove ignoreHTTPSErrors from playwright.config.ts before pointing the ` +
        `suite at a remote stack, or a substituted certificate would be accepted silently.`,
    );
  }
}

/**
 * Refuse to run while the API would really send the mail these tests provoke.
 *
 * 🔴 **Measured, in someone's inbox.** Every run registers a merchant at
 * `e2e-<stamp>@optionia.test`, a domain that does not resolve. With SMTP
 * configured the API sends the verification message for real, the receiving
 * server rejects it, and the bounce — *"Address not found"* — lands in the
 * mailbox `SMTP_USER` signs in as. The project's owner got one per run, from a
 * suite nobody thought was touching mail.
 *
 * ⚠️ **`.env.example` already documented this and it happened anyway.** A note
 * asking a person to remember is not a mechanism; this is the mechanism. The
 * same lesson the phase ledger records: *"a ledger nobody updates is a ledger
 * nobody can trust."*
 *
 * 📌 **Refuses rather than rewrites.** Emptying `SMTP_HOST` from a test harness
 * would edit configuration the developer chose, silently, and leave them
 * wondering why delivery stopped working. Failing with the reason costs one
 * line to fix and cannot surprise anyone.
 */
function assertMailIsNotSent(): void {
  const host = apiSmtpHost();

  if (host === '') {
    return;
  }

  throw new Error(
    `SMTP_HOST is set to "${host}", so this suite would send real verification ` +
      'email to e2e-…@optionia.test — a domain that does not resolve — and every ' +
      'run would bounce into the mailbox SMTP_USER signs in as.\n\n' +
      'Empty SMTP_HOST in optioniaWooCommerceBackend/.env and restart the API ' +
      '(a rebuild is not enough: nest start --watch keeps the environment it ' +
      'booted with). Messages then go to the ops log, verification link included, ' +
      'which is all these tests need — verifyEmail() marks the address verified ' +
      'in the database directly.',
  );
}

export default async function globalSetup(): Promise<void> {
  assertLocal();
  assertMailIsNotSent();

  const checks = await checkServices();
  const down = checks.filter((check) => !check.ok);

  for (const check of checks) {
    const mark = check.ok ? '✓' : '✗';
    console.log(`  ${mark} ${check.name.padEnd(18)} ${check.url}  (${check.detail})`);
  }

  if (down.length === 0) {
    /*
     * Only once the services are known good: cleanup talks to the same database
     * the API uses, and running it against an unreachable or misconfigured stack
     * would fail in a way that reads as a data problem.
     */
    const before = residue();

    cleanupPreviousRuns();

    const after = residue();

    if (before > 0) {
      console.log(`  ✓ cleaned up ${before - after} row(s) from previous runs`);
    }

    return;
  }

  const lines = down.map((check) => `  • ${check.name} — ${check.detail}\n    start it: ${check.hint}`);

  throw new Error(
    `\nThe canonical E2E needs three services, and ${down.length} ${
      down.length === 1 ? 'is' : 'are'
    } not answering:\n\n${lines.join('\n')}\n\n` +
      `Store URL in use: ${SERVICES.store}\n`,
  );
}
