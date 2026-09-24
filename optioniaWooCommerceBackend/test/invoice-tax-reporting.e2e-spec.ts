import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { InvoiceStatus } from '../src/common/database/enums';
import { mapInvoice } from '../src/billing/invoice.mapper';
import { Invoice } from '../src/billing/entities/invoice.entity';
import { Tenant } from '../src/tenants/entities/tenant.entity';
import { Plan } from '../src/plans/entities/plan.entity';
import { createHarness, type Harness } from './harness';

/**
 * What tax was collected, for a period, by country.
 *
 * 🔴 **This is the question ADR-115 obliges us to answer.** ParseLab is
 * merchant of record (ADR-114) and collects VAT through Stripe Tax — and
 * ✏️ **ADR-115 had to be corrected**: Stripe *calculates and collects* and
 * produces the reports a return is filed from; **filing is ours**. Filing needs
 * local rows, and before `invoices` nothing in this schema stored a tax amount
 * at all.
 *
 * ⚠️ **Against MySQL, not a mock**, for the reason `activation.e2e-spec.ts`
 * records: only the database can say whether a unique constraint holds. A unit
 * test asserting *"we store tax"* proves we wrote the word; this proves a
 * duplicate webhook cannot double a quarter's reported figure.
 */
describe('Invoice tax reporting (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;

  const run = uuidv7().slice(-8);
  let seq = 0;

  beforeAll(async () => {
    h = await createHarness('invtax');
    dataSource = h.app.get(DataSource);
  });

  afterAll(async () => {
    /* Invoices are RESTRICT on tenant, so they go first. Every run's, not just this one's. */
    await dataSource.query(
      `DELETE i FROM invoices i JOIN tenants t ON t.id = i.tenantId WHERE t.slug LIKE 'invtax-%'`,
    );
    await dataSource.query(
      `DELETE FROM subscriptions WHERE tenantId IN (SELECT id FROM tenants WHERE slug LIKE 'invtax-%')`,
    );
    await dataSource.query(`DELETE FROM tenants WHERE slug LIKE 'invtax-%'`);

    await h.close();
  });

  async function tenantIn(country: string) {
    const plan = await dataSource.getRepository(Plan).findOne({ where: { code: 'free' } });

    seq += 1;

    return dataSource.getRepository(Tenant).save(
      dataSource.getRepository(Tenant).create({
        name: `Tax ${run}-${seq}`,
        slug: `invtax-${run}-${seq}`,
        planId: plan!.id,
        country,
        billingCurrency: 'EUR',
      }),
    );
  }

  function invoice(tenantId: string, over: Partial<Invoice> = {}) {
    seq += 1;

    return dataSource.getRepository(Invoice).create({
      tenantId,
      provider: 'stripe',
      providerInvoiceId: `in_${run}_${seq}`,
      status: InvoiceStatus.PAID,
      currency: 'EUR',
      subtotalMinor: 2900,
      taxMinor: 609,
      totalMinor: 3509,
      taxCountry: 'DE',
      issuedAt: new Date('2026-08-15T00:00:00.000Z'),
      paidAt: new Date('2026-08-15T00:00:00.000Z'),
      ...over,
    });
  }

  /**
   * The mapper's output, stored (M22.C1).
   *
   * 🔴 **This is the half of C1's stated proof the unit tests cannot give.**
   * `invoice.mapper.spec.ts` asserts what the mapper returns; only MySQL can say
   * whether that shape survives `ck_invoices_totals`, the `char(2)` tax country
   * and the `char(3)` currency. A mapper whose rows the schema rejects is a
   * mapper that works in tests and fails on the first live webhook.
   *
   * ⚠️ Every field written here comes from `mapInvoice`, not from a fixture, so
   * a future change to either the mapper or the columns breaks this test rather
   * than only one side of the pair.
   */
  it('stores a row built by the mapper, through the real constraints', async () => {
    const tenant = await tenantIn('DE');

    seq += 1;
    const result = mapInvoice({
      id: `in_${run}_${seq}_mapped`,
      status: 'paid',
      currency: 'eur',
      subtotal: 2900,
      total_taxes: [{ amount: 609 }],
      total: 3509,
      created: 1_755_216_000,
      status_transitions: { paid_at: 1_755_216_060 },
      hosted_invoice_url: 'https://invoice.stripe.com/i/mapped',
      customer: 'cus_mapped',
      customer_address: { country: 'de' },
      parent: { subscription_details: { subscription: 'sub_mapped' } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const repo = dataSource.getRepository(Invoice);
    const { providerCustomerId, providerSubscriptionId, ...columns } = result.invoice;

    /* 📌 Those two are the caller's business — they resolve the tenant, and are
     * deliberately not columns on this table. Destructured so a future column
     * addition surfaces here rather than being silently dropped. */
    expect(providerCustomerId).toBe('cus_mapped');
    expect(providerSubscriptionId).toBe('sub_mapped');

    await repo.save(repo.create({ tenantId: tenant.id, provider: 'stripe', ...columns }));

    const stored = await repo.findOneOrFail({
      where: { providerInvoiceId: `in_${run}_${seq}_mapped` },
    });

    expect(stored.subtotalMinor + stored.taxMinor).toBe(stored.totalMinor);
    expect(stored.currency).toBe('EUR');
    expect(stored.taxCountry).toBe('DE');
    expect(stored.status).toBe(InvoiceStatus.PAID);
    expect(stored.hostedUrl).toBe('https://invoice.stripe.com/i/mapped');
  });

  /**
   * 🔴 **The mapper refuses what the CHECK would reject**, so a bad payload
   * fails at the boundary with a reason rather than as a database error on
   * insert — which is the difference between a logged finding and a 500.
   */
  it('never produces a row the totals constraint would refuse', async () => {
    const result = mapInvoice({
      id: 'in_inconsistent',
      status: 'paid',
      currency: 'eur',
      subtotal: 2900,
      total_taxes: [{ amount: 609 }],
      total: 9999,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'totals disagree: 2900 + 609 ≠ 9999',
    });
  });

  /**
   * 🔴 **The reporting query, which is the whole reason this table exists.**
   * A tax authority asks about a *period*, by country — not about one customer,
   * and not about a page of a provider's API.
   */
  it('answers "what tax did we collect, by country, in a period" in one query', async () => {
    const de = await tenantIn('DE');
    const fr = await tenantIn('FR');

    await dataSource.getRepository(Invoice).save([
      invoice(de.id),
      invoice(de.id),
      invoice(fr.id, { taxCountry: 'FR', taxMinor: 580, totalMinor: 3480 }),

      /*
       * Outside the period, and must not be counted.
       *
       * ✏️ **This row is where the new CHECK caught my own fixture.** It set
       * `taxMinor: 9999` and left `totalMinor` at the default 3509 — violating
       * the very invariant F92/D2 was about, in the test written to prove the
       * table works. The constraint refused it on its first run, which is the
       * clearest possible argument for enforcing arithmetic in the schema
       * rather than in a docblock.
       */
      invoice(de.id, {
        issuedAt: new Date('2026-07-01T00:00:00.000Z'),
        taxMinor: 9999,
        totalMinor: 12899,
      }),
    ]);

    const rows: Array<{ taxCountry: string; tax: string }> = await dataSource.query(
      `SELECT taxCountry, SUM(taxMinor) AS tax FROM invoices
        WHERE issuedAt >= ? AND issuedAt < ? AND status = 'paid'
          AND tenantId IN (SELECT id FROM tenants WHERE slug LIKE ?)
        GROUP BY taxCountry ORDER BY taxCountry`,
      ['2026-08-01', '2026-09-01', `invtax-${run}-%`],
    );

    expect(rows.map((r) => [r.taxCountry, Number(r.tax)])).toEqual([
      ['DE', 1218],
      ['FR', 580],
    ]);
  });

  /**
   * 🔴 **A duplicate webhook must not double the quarter.** Providers redeliver
   * on any non-2xx, by design — so the second delivery has to find this row
   * already present rather than write a second one.
   */
  it('refuses a second invoice with the same provider id', async () => {
    const tenant = await tenantIn('IE');
    const first = invoice(tenant.id, { taxCountry: 'IE' });

    await dataSource.getRepository(Invoice).save(first);

    const redelivered = invoice(tenant.id, { taxCountry: 'IE' });

    redelivered.providerInvoiceId = first.providerInvoiceId;

    await expect(dataSource.getRepository(Invoice).save(redelivered)).rejects.toThrow();
  });

  /**
   * 🔴 **The invariant I wrote and did not enforce (F92/D2).**
   *
   * `subtotalMinor + taxMinor = totalMinor` lived in a docblock, and the tests
   * above never compared the three columns — their fixture happens to be
   * consistent, so an adapter writing a wrong total would have passed all of
   * them and surfaced months later as a **tax return that does not reconcile
   * against the bank**.
   *
   * ⚠️ **Asserted against MySQL rather than trusted from the DDL.** `CHECK` is
   * enforced from 8.0.16 and silently *parsed and ignored* before it — so a
   * migration that adds one proves nothing on its own. This is what proves it.
   */
  it('refuses an invoice whose total does not equal subtotal plus tax', async () => {
    const tenant = await tenantIn('BE');

    await expect(
      dataSource.getRepository(Invoice).save(
        invoice(tenant.id, { taxCountry: 'BE', subtotalMinor: 2900, taxMinor: 609, totalMinor: 9999 }),
      ),
    ).rejects.toThrow();
  });

  /**
   * 📌 **A credit note satisfies the same equality.** The columns are signed,
   * and the check is an equality rather than a positivity test — requiring
   * non-negative amounts would have made refunds unstorable, which is the
   * over-constraint this deliberately avoids.
   */
  it('accepts a credit note, where every amount is negative', async () => {
    const tenant = await tenantIn('AT');

    const saved = await dataSource.getRepository(Invoice).save(
      invoice(tenant.id, {
        taxCountry: 'AT',
        status: InvoiceStatus.PAID,
        subtotalMinor: -2900,
        taxMinor: -609,
        totalMinor: -3509,
      }),
    );

    expect(saved.totalMinor).toBe(-3509);
  });

  /**
   * ⚠️ **Reverse charge is zero tax at a real rate, not missing data.** An EU
   * B2B sale to a valid VAT number is taxed at 0% with the liability moved to
   * the buyer — so `taxMinor = 0` must be storable and must survive a read,
   * rather than being treated as "not yet known".
   */
  it('stores a reverse-charge sale as zero tax, not as absent', async () => {
    const tenant = await tenantIn('NL');

    const saved = await dataSource.getRepository(Invoice).save(
      invoice(tenant.id, { taxCountry: 'NL', taxMinor: 0, totalMinor: 2900 }),
    );

    const reloaded = await dataSource
      .getRepository(Invoice)
      .findOne({ where: { id: saved.id } });

    expect(reloaded?.taxMinor).toBe(0);
    expect(reloaded?.totalMinor).toBe(2900);
  });

  /**
   * 📌 **The country is the invoice's, not the tenant's.** A merchant may move;
   * a return for a past period must reflect where they were taxed **at the
   * time**, so the invoice carries its own copy.
   */
  it('keeps the tax country recorded on the invoice when the tenant moves', async () => {
    const tenant = await tenantIn('ES');

    const saved = await dataSource
      .getRepository(Invoice)
      .save(invoice(tenant.id, { taxCountry: 'ES' }));

    await dataSource.getRepository(Tenant).update(tenant.id, { country: 'PT' });

    const reloaded = await dataSource
      .getRepository(Invoice)
      .findOne({ where: { id: saved.id } });

    expect(reloaded?.taxCountry).toBe('ES');
  });
});
