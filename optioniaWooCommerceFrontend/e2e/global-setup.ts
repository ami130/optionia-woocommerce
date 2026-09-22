import { cleanupPreviousRuns, residue } from './cleanup';
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

export default async function globalSetup(): Promise<void> {
  assertLocal();

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
