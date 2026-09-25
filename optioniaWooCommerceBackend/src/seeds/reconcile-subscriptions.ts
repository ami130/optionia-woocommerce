import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { createStripeClient } from '../billing/billing.module';
import { StripeProvider } from '../billing/stripe.provider';
import { ConfigVersionService } from '../common/config-version.service';
import { PlanChangeInvalidatorService } from '../billing/plan-change-invalidator.service';
import { SubscriptionReconcilerService } from '../billing/subscription-reconciler.service';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { buildDataSourceOptions } from '../config/data-source';
import { loadConfig } from '../config/env';

/**
 * `npm run billing:reconcile` — M23.5's diff of provider state against ours.
 *
 * 🔴 **Webhooks are the only thing that moves subscription state, and a webhook
 * can be missed.** A 500 that outlives Stripe's retries, an endpoint
 * misconfigured for a day, a deploy that drops a delivery — any of them strands
 * a paying merchant on the wrong plan, and **nothing else would ever notice**.
 *
 * ## Reporting is the default; repair is opt-in
 *
 * ⚠️ **`--repair` is required to write anything.** F91's principle holds here:
 * the provider is authoritative, but acting on every difference automatically
 * is dangerous in a way that reporting is not. A provider outage answering
 * oddly — or a bug in the comparison itself — would otherwise rewrite every
 * subscription in the database in a single pass.
 *
 * ## Deliberately not a seed, and deliberately not a cron decoration
 *
 * 📌 `openSeedConnection` refuses to run under `NODE_ENV=production`, and
 * rightly — seeds insert fabricated data. Reconciliation is exactly what live
 * mode needs, so this opens its own connection, as `billing:link-prices` does.
 *
 * 📌 **The milestone says "scheduled diff"; the value is the diff.** What runs
 * this — cron, BullMQ, `@nestjs/schedule`, a Kubernetes CronJob — is M23.4's
 * open question and changes nothing here.
 *
 * ## Flags
 *
 * - `--repair` writes the provider's values back. Without it, nothing is written.
 */
async function main(): Promise<void> {
  loadDotenv();

  const argv = process.argv.slice(2);
  const repair = argv.includes('--repair');
  const config = loadConfig();

  if (config.billing.secretKey === null) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. This command talks to the provider and cannot run without it.',
    );
  }

  const dataSource = new DataSource(buildDataSourceOptions(config));

  await dataSource.initialize();

  try {
    const provider = new StripeProvider(
      createStripeClient(config.billing.secretKey),
      config.billing.webhookSecret ?? '',
    );

    /* 📌 F121: a repaired plan invalidates the tenant's storefront config. */
    const invalidator = new PlanChangeInvalidatorService(dataSource, new ConfigVersionService());

    const reconciler = new SubscriptionReconcilerService(
      dataSource.getRepository(Subscription),
      dataSource.getRepository(PlanPrice),
      provider,
      invalidator,
    );

    const outcome = await reconciler.reconcile({ dryRun: !repair });

    console.log(
      `Checked ${outcome.checked} subscription(s)${repair ? '' : ' (dry run: nothing written)'}`,
    );

    for (const finding of outcome.findings) {
      const verb = finding.repaired ? 'repaired' : 'DRIFT';

      console.log(
        `  ${verb}  tenant ${finding.tenantId}  ${finding.field}: ` +
          `${finding.local ?? '—'} → ${finding.remote ?? '—'}`,
      );
    }

    for (const error of outcome.errors) {
      console.error(`  ERROR  ${error}`);
    }

    /*
     * ⚠️ **A non-zero exit, because this runs unattended.** Drift reported on
     * stdout with a zero exit is drift that gets scrolled past — and the whole
     * point is that nobody is watching these subscriptions.
     */
    if (outcome.findings.length > 0 || outcome.errors.length > 0) {
      console.error(
        `\n${outcome.findings.length} difference(s), ${outcome.errors.length} error(s).` +
          (repair ? '' : ' Re-run with --repair to apply the provider’s values.'),
      );

      process.exitCode = 1;

      return;
    }

    console.log('\nEvery linked subscription agrees with the provider.');
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(`billing:reconcile failed: ${(error as Error).message}`);
  process.exit(1);
});
