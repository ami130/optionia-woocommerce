import { config as loadDotenv } from 'dotenv';
import { DataSource, In, Repository } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { runWithContext, type RequestContext } from '../src/common/context/request-context';
import { TenantScopedRepository } from '../src/common/tenancy/tenant-scoped.repository';
import { OptionSet } from '../src/option-sets/entities/option-set.entity';

/**
 * Tenant isolation at the data layer (AC5, M6.4).
 *
 * Two tenants with real rows, and every assertion is about what the *database*
 * returns. A mocked repository would agree with whatever the code passed it,
 * which is exactly the class of bug this layer exists to make impossible.
 */
class OptionSetsRepository extends TenantScopedRepository<OptionSet> {
  constructor(repository: Repository<OptionSet>) {
    super(repository);
  }

  /** Exposes the escape hatch so the test can prove it is genuinely unscoped. */
  unscoped(): Repository<OptionSet> {
    return this.unsafeUnscopedRepository;
  }
}

describe('TenantScopedRepository (integration)', () => {
  let dataSource: DataSource;
  let sets: OptionSetsRepository;

  const NS = 'scoped';
  const TENANT_A = 'scoped-tenant-a';
  const TENANT_B = 'scoped-tenant-b';

  /** Run a callback as if inside a request for one tenant. */
  function asTenant<R>(tenantId: string, fn: () => Promise<R>): Promise<R> {
    const context: RequestContext = {
      requestId: 'test',
      startedAt: Date.now(),
      tenantId,
      userId: 'test-user',
    };

    return runWithContext(context, fn);
  }

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();
    sets = new OptionSetsRepository(dataSource.getRepository(OptionSet));
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM option_sets WHERE tenantId LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM stores WHERE tenantId LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE id LIKE '${NS}-%'`);
  }

  beforeEach(async () => {
    await cleanup();

    const [plan] = await dataSource.query(`SELECT id FROM plans WHERE code = 'free'`);

    for (const [id, slug] of [
      [TENANT_A, `${NS}-a`],
      [TENANT_B, `${NS}-b`],
    ]) {
      // Neither table is soft-deletable, so neither carries `deletedAt`. Written
      // out column by column rather than copied from another fixture, because a
      // column that does not exist fails at the first query with an error that
      // names the column and nothing about why.
      await dataSource.query(
        `INSERT INTO tenants (id, name, slug, status, planId, createdAt, updatedAt)
         VALUES (?, ?, ?, 'active', ?, NOW(3), NOW(3))`,
        [id, slug, slug, plan.id],
      );
      await dataSource.query(
        `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status,
                             configVersion, createdAt, updatedAt)
         VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
        [`${id}-store`, id, slug, `https://${slug}.example.com`],
      );
    }

    // Two rows per tenant, named so a leak is obvious in a failure message.
    for (const tenant of [TENANT_A, TENANT_B]) {
      for (const n of [1, 2]) {
        await dataSource.query(
          `INSERT INTO option_sets
             (id, tenantId, storeId, name, status, version, rowVersion,
              publishedConfigVersion, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, 'draft', 1, 1, 0, NOW(3), NOW(3),
                   '1970-01-01 00:00:00.000')`,
          [`${tenant}-p${n}`, tenant, `${tenant}-store`, `${tenant}-set-${n}`],
        );
      }
    }
  });

  describe('reads see only the acting tenant', () => {
    it('find returns this tenant only', async () => {
      const rows = await asTenant(TENANT_A, () => sets.find());

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    });

    it('count counts this tenant only', async () => {
      expect(await asTenant(TENANT_A, () => sets.count())).toBe(2);
      expect(await asTenant(TENANT_B, () => sets.count())).toBe(2);
    });

    /**
     * The most direct attack: ask for a row by an id you were given. It must be
     * indistinguishable from an id that does not exist.
     */
    it('findById refuses another tenant’s id', async () => {
      const own = await asTenant(TENANT_A, () => sets.findById(`${TENANT_A}-p1`));
      const other = await asTenant(TENANT_A, () => sets.findById(`${TENANT_B}-p1`));
      const missing = await asTenant(TENANT_A, () => sets.findById('does-not-exist'));

      expect(own).not.toBeNull();
      expect(other).toBeNull();
      expect(other).toEqual(missing);
    });

    /**
     * A caller-supplied `where` must not be able to reach outside the tenant,
     * even naming the column directly.
     */
    it('cannot be widened by a caller-supplied tenantId', async () => {
      const rows = await asTenant(TENANT_A, () =>
        sets.find({ where: { tenantId: TENANT_B } as never }),
      );

      // The predicate is merged *after* the caller's `where`, so a supplied
      // tenantId is overwritten rather than honoured. The result is this
      // tenant's own rows — never tenant B's, which is the property under test.
      expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
      expect(rows.some((r) => r.tenantId === TENANT_B)).toBe(false);
    });

    /** An array `where` is an OR — every branch needs the predicate. */
    it('scopes every branch of an OR', async () => {
      const rows = await asTenant(TENANT_A, () =>
        sets.find({
          where: [{ name: `${TENANT_A}-set-1` }, { name: `${TENANT_B}-set-1` }] as never,
        }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(TENANT_A);
    });

    it('findAndCount and exists are scoped too', async () => {
      const [rows, total] = await asTenant(TENANT_A, () => sets.findAndCount());
      expect(rows).toHaveLength(2);
      expect(total).toBe(2);

      const found = await asTenant(TENANT_A, () =>
        sets.exists({ id: `${TENANT_B}-p1` } as never),
      );
      expect(found).toBe(false);
    });
  });

  describe('writes stay inside the acting tenant', () => {
    it('stamps the tenant on create, ignoring any supplied value', async () => {
      const created = await asTenant(TENANT_A, () =>
        sets.create({
          storeId: `${TENANT_A}-store`,
          name: 'created',
          status: 'draft',
          version: 1,
          rowVersion: 1,
          publishedConfigVersion: 0,
          // A hostile payload naming another tenant.
          tenantId: TENANT_B,
        } as never),
      );

      expect(created.tenantId).toBe(TENANT_A);
    });

    it('update cannot reach another tenant’s row', async () => {
      const result = await asTenant(TENANT_A, () =>
        sets.update({ id: `${TENANT_B}-p1` } as never, { name: 'hijacked' }),
      );

      expect(result.affected).toBe(0);

      const [row] = await dataSource.query(`SELECT name FROM option_sets WHERE id = ?`, [
        `${TENANT_B}-p1`,
      ]);
      expect(row.name).toBe(`${TENANT_B}-set-1`);
    });

    /**
     * A write leak rather than a read one: moving a row into another tenant is
     * just as damaging as reading from one.
     */
    it('update cannot move a row into another tenant', async () => {
      await asTenant(TENANT_A, () =>
        sets.update({ id: `${TENANT_A}-p1` } as never, { tenantId: TENANT_B } as never),
      );

      const [row] = await dataSource.query(`SELECT tenantId FROM option_sets WHERE id = ?`, [
        `${TENANT_A}-p1`,
      ]);
      expect(row.tenantId).toBe(TENANT_A);
    });

    it('delete cannot reach another tenant’s row', async () => {
      const result = await asTenant(TENANT_A, () =>
        sets.delete({ id: `${TENANT_B}-p1` } as never),
      );

      expect(result.affected).toBe(0);
      expect(await asTenant(TENANT_B, () => sets.count())).toBe(2);
    });

    /** An entity loaded elsewhere could carry another tenant's id. */
    it('save refuses an entity from another tenant', async () => {
      const foreign = await asTenant(TENANT_B, () => sets.findById(`${TENANT_B}-p1`));

      await expect(asTenant(TENANT_A, () => sets.save(foreign as never))).rejects.toThrow(
        /Refusing to save/,
      );
    });
  });

  describe('option handling, checked against the parent-scoped bugs', () => {
    /**
     * `ParentScopedRepository` builds its own query and dropped three options
     * silently: an array `where`, a `FindOperator`, and `relations`. This class
     * delegates to TypeORM's `find()`, so it should handle all three — asserted
     * rather than assumed, because "the library does it" is exactly the reasoning
     * that left the other one broken.
     */
    it('honours an array where as an OR that still filters', async () => {
      const none = await asTenant(TENANT_A, () =>
        sets.find({ where: [{ id: 'nope-1' }, { id: 'nope-2' }] as never }),
      );

      expect(none).toHaveLength(0);
    });

    it('cannot reach another tenant through an OR', async () => {
      const rows = await asTenant(TENANT_A, () =>
        sets.find({ where: [{ id: `${TENANT_A}-p1` }, { id: `${TENANT_B}-p1` }] as never }),
      );

      expect(rows.map((r) => r.id)).toEqual([`${TENANT_A}-p1`]);
    });

    it('expands a FindOperator rather than stringifying it', async () => {
      const rows = await asTenant(TENANT_A, () =>
        sets.find({ where: { id: In([`${TENANT_A}-p1`, 'nope']) } as never }),
      );

      expect(rows.map((r) => r.id)).toEqual([`${TENANT_A}-p1`]);
    });

    it('honours a relation request', async () => {
      const rows = await asTenant(TENANT_A, () =>
        sets.find({ relations: { store: true } as never }),
      );

      expect(rows[0]).toHaveProperty('store');
    });
  });

  describe('without a tenant context', () => {
    /**
     * The acceptance criterion for M6.4: a service method that forgets tenant
     * scoping cannot leak data — it throws. Returning unscoped rows here would
     * be every row in the table, silently.
     */
    it('throws rather than returning every row', async () => {
      await expect(sets.find()).rejects.toThrow(/No tenant in the request context/);
      await expect(sets.count()).rejects.toThrow(/No tenant in the request context/);
      await expect(sets.findById('anything')).rejects.toThrow(
        /No tenant in the request context/,
      );
    });

    it('throws on writes too', async () => {
      await expect(sets.delete({ id: 'x' } as never)).rejects.toThrow(
        /No tenant in the request context/,
      );
    });
  });

  describe('the escape hatch is genuinely unscoped', () => {
    /**
     * Documented, named unpleasantly, and proven to behave as advertised — so
     * nobody discovers later that it was quietly safe and relied on that.
     */
    it('returns rows from every tenant', async () => {
      const all = await sets
        .unscoped()
        .find({ where: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }] });

      expect(all).toHaveLength(4);
    });
  });
});
