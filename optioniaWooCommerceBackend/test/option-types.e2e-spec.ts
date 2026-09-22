import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { OptionTypeValidator } from '../src/option-sets/types/option-type.validator';
import { pricingConfigSchema } from '../src/option-sets/types/pricing.schema';

/**
 * The type registry, against rows the database actually holds.
 *
 * **This suite exists because the unit tests passed while every real row
 * failed.** They validated hand-written objects, where an unconfigured column is
 * `undefined`; MySQL returns `null`, and the validator skipped only the former.
 * All 45 seeded options were rejected on `validation: null`, and nothing noticed
 * because nothing read a row.
 *
 * A schema is a claim about stored data. Testing it only against literals tests
 * the claim against itself.
 */
describe('option types (integration)', () => {
  let dataSource: DataSource;
  const validator = new OptionTypeValidator();

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('accepts every option the seeds create', async () => {
    const rows: Array<{
      id: string;
      presentation: string;
      validation: unknown;
      pricing: unknown;
      display: unknown;
    }> = await dataSource.query(
      `SELECT id, presentation, validation, pricing, display FROM options`,
    );

    expect(rows.length).toBeGreaterThan(0);

    const rejected = rows.filter((row) => {
      try {
        validator.assertValidOption(row.presentation, {
          validation: row.validation,
          pricing: row.pricing,
          display: row.display,
        });

        return false;
      } catch {
        return true;
      }
    });

    expect(rejected.map((r) => r.id)).toEqual([]);
  });

  /**
   * An unconfigured column is `null` in the database and `undefined` in a
   * literal. Both mean "not configured" and neither is a mistake.
   */
  it('treats a null column as not configured', async () => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM options WHERE validation IS NULL`,
    );

    // The seeds genuinely produce nulls, so this is not a hypothetical.
    expect(Number(row.n)).toBeGreaterThan(0);

    expect(() =>
      validator.assertValidOption('radio', { validation: null, pricing: null, display: null }),
    ).not.toThrow();
  });

  /**
   * Every stored option must be a coherent triple. A row whose axes disagree
   * with its presentation cannot be rendered or priced, and the database has no
   * constraint preventing one.
   */
  it('stores no option whose axes disagree with its type', async () => {
    const rows: Array<{
      id: string;
      presentation: string;
      valueKind: string;
      cardinality: string;
    }> = await dataSource.query(
      `SELECT id, presentation, valueKind, cardinality FROM options`,
    );

    const incoherent = rows.filter((row) => {
      try {
        validator.assertValidOption(row.presentation, {
          valueKind: row.valueKind,
          cardinality: row.cardinality,
        });

        return false;
      } catch {
        return true;
      }
    });

    expect(incoherent.map((r) => `${r.presentation}/${r.valueKind}/${r.cardinality}`)).toEqual(
      [],
    );
  });

  it('accepts every price config the seeds create', async () => {
    const rows: Array<{ id: string; priceConfig: unknown }> = await dataSource.query(
      `SELECT id, priceConfig FROM option_values WHERE priceConfig IS NOT NULL`,
    );

    const rejected = rows.filter((row) => !pricingConfigSchema.safeParse(row.priceConfig).success);

    expect(rejected.map((r) => r.id)).toEqual([]);
  });

  /**
   * Every presentation stored must be one the registry knows, or the option
   * cannot be validated, serialized or rendered.
   */
  it('has a registry entry for every presentation in the database', async () => {
    const rows: Array<{ presentation: string }> = await dataSource.query(
      `SELECT DISTINCT presentation FROM options`,
    );

    rows.forEach((row) => {
      expect(() => validator.assertValidOption(row.presentation, {})).not.toThrow();
    });
  });

  /**
   * A JSON column round-trips through the driver, so a schema that passes in
   * memory can still fail on what MySQL returns — numbers as strings being the
   * classic case.
   */
  it('validates a price config written to and read from the database', async () => {
    const [value] = await dataSource.query(`SELECT id FROM option_values LIMIT 1`);

    await dataSource.query(`UPDATE option_values SET priceConfig = ? WHERE id = ?`, [
      JSON.stringify({ type: 'fixed', amountMinor: 1500 }),
      value.id,
    ]);

    const [row] = await dataSource.query(`SELECT priceConfig FROM option_values WHERE id = ?`, [
      value.id,
    ]);

    const parsed = pricingConfigSchema.safeParse(row.priceConfig);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ amountMinor: 1500 });

    await dataSource.query(`UPDATE option_values SET priceConfig = NULL WHERE id = ?`, [
      value.id,
    ]);
  });
});
