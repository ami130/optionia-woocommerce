import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

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
      status: 'paid',
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

      /* Outside the period, and must not be counted. */
      invoice(de.id, { issuedAt: new Date('2026-07-01T00:00:00.000Z'), taxMinor: 9999 }),
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
