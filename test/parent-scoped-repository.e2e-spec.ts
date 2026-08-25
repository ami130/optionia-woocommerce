import { config as loadDotenv } from 'dotenv';
import { DataSource, In, Not, Repository } from 'typeorm';

import { runWithContext, type RequestContext } from '../src/common/context/request-context';
import { ParentScopedRepository } from '../src/common/tenancy/parent-scoped.repository';
import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { OptionGroup } from '../src/option-sets/entities/option-group.entity';
import { Option } from '../src/option-sets/entities/option.entity';
import { OptionValue } from '../src/option-sets/entities/option-value.entity';

/**
 * Tenant isolation for entities that reach their tenant through a parent (7b).
 *
 * `option_sets` carries `tenant_id`; these do not. A group is one join from it,
 * an option two, a value three — and the depth is the point: a predicate that
 * works at one hop and silently stops working at three is the failure this suite
 * exists to catch.
 */
class Groups extends ParentScopedRepository<OptionGroup> {
  constructor(r: Repository<OptionGroup>) {
    super(r, 'g', [{ table: 'option_sets', on: 'optionSetId' }]);
  }
}

class Options extends ParentScopedRepository<Option> {
  constructor(r: Repository<Option>) {
    super(r, 'o', [
      { table: 'option_groups', on: 'optionGroupId' },
      { table: 'option_sets', on: 'optionSetId' },
    ]);
  }
}

class Values extends ParentScopedRepository<OptionValue> {
  constructor(r: Repository<OptionValue>) {
    super(r, 'v', [
      { table: 'options', on: 'optionId' },
      { table: 'option_groups', on: 'optionGroupId' },
      { table: 'option_sets', on: 'optionSetId' },
    ]);
  }
}

describe('ParentScopedRepository (integration)', () => {
  let dataSource: DataSource;
  let groups: Groups;
  let options: Options;
  let values: Values;

  const NS = 'psr';
  const A = `${NS}-tenant-a`;
  const B = `${NS}-tenant-b`;

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

    groups = new Groups(dataSource.getRepository(OptionGroup));
    options = new Options(dataSource.getRepository(Option));
    values = new Values(dataSource.getRepository(OptionValue));
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM option_values WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM options WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM option_groups WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM option_sets WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM stores WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE id LIKE '${NS}-%'`);
  }

  /** Two tenants, each with a full set → group → option → value chain. */
  beforeEach(async () => {
    await cleanup();

    const [plan] = await dataSource.query(`SELECT id FROM plans WHERE code = 'free'`);
    const S = `'1970-01-01 00:00:00.000'`;

    for (const t of [A, B]) {
      await dataSource.query(
        `INSERT INTO tenants (id, name, slug, status, planId, createdAt, updatedAt)
         VALUES (?, ?, ?, 'active', ?, NOW(3), NOW(3))`,
        [t, t, t, plan.id],
      );
      await dataSource.query(
        `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                             createdAt, updatedAt)
         VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
        [`${t}-store`, t, t, `https://${t}.example.com`],
      );
      await dataSource.query(
        `INSERT INTO option_sets (id, tenantId, storeId, name, status, version, rowVersion,
                                  publishedConfigVersion, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, 'set', 'draft', 1, 1, 0, NOW(3), NOW(3), ${S})`,
        [`${t}-set`, t, `${t}-store`],
      );
      await dataSource.query(
        `INSERT INTO option_groups (id, optionSetId, label, description, displayType,
                                    sortOrder, isCollapsible, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'shared-label', '', 'inline', 1, 0, NOW(3), NOW(3), ${S})`,
        [`${t}-group`, `${t}-set`],
      );
      await dataSource.query(
        `INSERT INTO options (id, optionGroupId, \`key\`, valueKind, cardinality, presentation,
                              label, description, placeholder, helpText, isRequired, sortOrder,
                              createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'size', 'choice', 'one', 'radio', 'shared-label', '', '', '', 0, 1,
                 NOW(3), NOW(3), ${S})`,
        [`${t}-option`, `${t}-group`],
      );
      await dataSource.query(
        `INSERT INTO option_values (id, optionId, valueKey, label, sortOrder, priceType,
                                    priceAmountMinor, isDefault, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'small', 'shared-label', 1, 'fixed', 0, 0, NOW(3), NOW(3), ${S})`,
        [`${t}-value`, `${t}-option`],
      );
    }
  });

  describe('one join — groups', () => {
    it('returns only this tenant’s groups', async () => {
      const rows = await asTenant(A, () => groups.find());

      expect(rows.map((r) => r.id)).toEqual([`${A}-group`]);
    });

    it('refuses another tenant’s id exactly as a missing one', async () => {
      const foreign = await asTenant(A, () => groups.findById(`${B}-group`));
      const missing = await asTenant(A, () => groups.findById('nope'));

      expect(foreign).toBeNull();
      expect(foreign).toEqual(missing);
    });
  });

  describe('two joins — options', () => {
    it('returns only this tenant’s options', async () => {
      const rows = await asTenant(A, () => options.find());

      expect(rows.map((r) => r.id)).toEqual([`${A}-option`]);
    });

    it('refuses another tenant’s option', async () => {
      expect(await asTenant(A, () => options.findById(`${B}-option`))).toBeNull();
    });
  });

  describe('three joins — values', () => {
    /**
     * The depth that matters. A predicate applied to the nearest parent only
     * would pass at one hop and leak here.
     */
    it('returns only this tenant’s values', async () => {
      const rows = await asTenant(A, () => values.find());

      expect(rows.map((r) => r.id)).toEqual([`${A}-value`]);
    });

    it('refuses another tenant’s value', async () => {
      expect(await asTenant(A, () => values.findById(`${B}-value`))).toBeNull();
    });

    it('counts only this tenant’s values', async () => {
      expect(await asTenant(A, () => values.count())).toBe(1);
      expect(await asTenant(B, () => values.count())).toBe(1);
    });
  });

  describe('a caller cannot widen the scope', () => {
    /** Both tenants have a row labelled `shared-label`. */
    it('filters within the tenant, not across it', async () => {
      const rows = await asTenant(A, () =>
        options.find({ where: { label: 'shared-label' } as never }),
      );

      expect(rows.map((r) => r.id)).toEqual([`${A}-option`]);
    });

    it('cannot reach another tenant by naming its id in a filter', async () => {
      const rows = await asTenant(A, () =>
        options.find({ where: { id: `${B}-option` } as never }),
      );

      expect(rows).toHaveLength(0);
    });
  });

  describe('writes stay inside the tenant', () => {
    it('cannot update another tenant’s row', async () => {
      const result = await asTenant(A, () =>
        options.update({ id: `${B}-option` } as never, { label: 'hijacked' } as never),
      );

      expect(result.affected).toBe(0);

      const [row] = await dataSource.query(`SELECT label FROM options WHERE id = ?`, [
        `${B}-option`,
      ]);
      expect(row.label).toBe('shared-label');
    });

    it('cannot delete another tenant’s row', async () => {
      const result = await asTenant(A, () => values.delete({ id: `${B}-value` } as never));

      expect(result.affected).toBe(0);
      expect(await asTenant(B, () => values.count())).toBe(1);
    });

    it('refuses to save an entity from another tenant', async () => {
      const foreign = await asTenant(B, () => options.findById(`${B}-option`));

      await expect(asTenant(A, () => options.save(foreign as never))).rejects.toThrow(
        /does not belong to tenant/,
      );
    });

    /**
     * An insert has no row to join from, so the parent is verified instead —
     * the one operation where the check is separate from the write.
     */
    it('refuses to create under another tenant’s parent', async () => {
      await expect(
        asTenant(A, () =>
          options.create(`${B}-group`, {
            optionGroupId: `${B}-group`,
            key: 'smuggled',
            valueKind: 'choice',
            cardinality: 'one',
            presentation: 'radio',
            label: 'smuggled',
          } as never),
        ),
      ).rejects.toThrow(/not found/);
    });

    it('creates under its own parent', async () => {
      const created = await asTenant(A, () =>
        options.create(`${A}-group`, {
          optionGroupId: `${A}-group`,
          key: 'colour',
          valueKind: 'choice',
          cardinality: 'one',
          presentation: 'radio',
          label: 'Colour',
        } as never),
      );

      expect(created.id).toBeTruthy();
      expect(await asTenant(A, () => options.count())).toBe(2);
      expect(await asTenant(B, () => options.count())).toBe(1);
    });
  });

  describe('the permitted operations actually work', () => {
    /**
     * Every refusal path was covered and none of the success paths were. A guard
     * that blocks the right things while breaking the right things is not a
     * working repository — and "it refuses correctly" is the easier half to get
     * right.
     */
    it('findOne returns this tenant’s row', async () => {
      const row = await asTenant(A, () =>
        options.findOne({ where: { key: 'size' } as never }),
      );

      expect(row?.id).toBe(`${A}-option`);
    });

    it('exists answers true for own and false for foreign', async () => {
      expect(await asTenant(A, () => options.exists({ id: `${A}-option` } as never))).toBe(
        true,
      );
      expect(await asTenant(A, () => options.exists({ id: `${B}-option` } as never))).toBe(
        false,
      );
    });

    it('update changes this tenant’s row', async () => {
      const result = await asTenant(A, () =>
        options.update({ id: `${A}-option` } as never, { label: 'renamed' } as never),
      );

      expect(result.affected).toBe(1);

      const [row] = await dataSource.query(`SELECT label FROM options WHERE id = ?`, [
        `${A}-option`,
      ]);
      expect(row.label).toBe('renamed');
    });

    it('delete removes this tenant’s row', async () => {
      const result = await asTenant(A, () => values.delete({ id: `${A}-value` } as never));

      expect(result.affected).toBe(1);
      expect(await asTenant(A, () => values.count())).toBe(0);
      // B's value is untouched.
      expect(await asTenant(B, () => values.count())).toBe(1);
    });

    it('save persists an entity this tenant owns', async () => {
      const row = await asTenant(A, () => groups.findById(`${A}-group`));
      row!.label = 'saved';

      await asTenant(A, () => groups.save(row as never));

      const [after] = await dataSource.query(`SELECT label FROM option_groups WHERE id = ?`, [
        `${A}-group`,
      ]);
      expect(after.label).toBe('saved');
    });

    /** Pagination must not become a way past the predicate. */
    it('paginates within the tenant', async () => {
      await asTenant(A, () =>
        options.create(`${A}-group`, {
          optionGroupId: `${A}-group`,
          key: 'second',
          valueKind: 'choice',
          cardinality: 'one',
          presentation: 'radio',
          label: 'Second',
        } as never),
      );

      const page = await asTenant(A, () => options.find({ take: 1, order: { key: 'ASC' } }));

      // `take` limits the page; the tenant predicate still decides the set it is
      // taken from. Asserting *which* row came first would test the sort order,
      // which is not the property at risk here.
      expect(page).toHaveLength(1);
      expect(await asTenant(A, () => options.count())).toBe(2);
      expect(await asTenant(B, () => options.count())).toBe(1);
    });
  });

  describe('soft delete', () => {
    /**
     * M7.2: deleting an option set excludes its groups, options and values.
     *
     * The join originally matched on `id` alone, so a deleted set still exposed
     * everything beneath it — a merchant deletes a set and its options remain
     * listed, which reads as data they cannot remove.
     */
    it('hides children of a deleted parent', async () => {
      expect(await asTenant(A, () => options.count())).toBe(1);

      await dataSource.query(`UPDATE option_sets SET deletedAt = NOW(3) WHERE id = ?`, [
        `${A}-set`,
      ]);

      expect(await asTenant(A, () => options.count())).toBe(0);
      expect(await asTenant(A, () => values.count())).toBe(0);
    });

    it('hides a deleted row itself', async () => {
      await dataSource.query(`UPDATE options SET deletedAt = NOW(3) WHERE id = ?`, [
        `${A}-option`,
      ]);

      expect(await asTenant(A, () => options.findById(`${A}-option`))).toBeNull();
      expect(await asTenant(A, () => options.count())).toBe(0);
    });

    /** A deleted parent cannot receive new children. */
    it('refuses to create under a deleted parent', async () => {
      await dataSource.query(`UPDATE option_groups SET deletedAt = NOW(3) WHERE id = ?`, [
        `${A}-group`,
      ]);

      await expect(
        asTenant(A, () =>
          options.create(`${A}-group`, {
            optionGroupId: `${A}-group`,
            key: 'orphan',
            valueKind: 'choice',
            cardinality: 'one',
            presentation: 'radio',
            label: 'Orphan',
          } as never),
        ),
      ).rejects.toThrow(/not found/);
    });

    /** Deleting one tenant's set must not touch another's. */
    it('leaves the other tenant untouched', async () => {
      await dataSource.query(`UPDATE option_sets SET deletedAt = NOW(3) WHERE id = ?`, [
        `${A}-set`,
      ]);

      expect(await asTenant(B, () => options.count())).toBe(1);
      expect(await asTenant(B, () => values.count())).toBe(1);
    });
  });

  describe('every option is honoured or refused', () => {
    /**
     * **The surface is enumerated here rather than sampled.**
     *
     * Three bugs of one shape were found by probing options one at a time:
     * an array `where` returned every row in the tenant, `relations` was silently
     * dropped, and a `FindOperator` became `= '[object Object]'`. Each was
     * accepted by the type signature and discarded by the implementation, so the
     * failure was invisible at the call site.
     *
     * This block covers all thirteen `FindManyOptions` keys — the five supported
     * and the eight refused — so a future option cannot join them quietly.
     */
    describe('supported', () => {
      it('where — object, as an AND of its fields', async () => {
        const rows = await asTenant(A, () =>
          options.find({ where: { key: 'size', label: 'shared-label' } as never }),
        );

        expect(rows.map((r) => r.id)).toEqual([`${A}-option`]);
      });

      /**
       * An array is an OR. It previously returned every row in the tenant,
       * because the clause was discarded entirely.
       */
      it('where — array, as an OR that still filters', async () => {
        const none = await asTenant(A, () =>
          options.find({ where: [{ id: 'nope-1' }, { id: 'nope-2' }] as never }),
        );

        expect(none).toHaveLength(0);

        const one = await asTenant(A, () =>
          options.find({ where: [{ id: `${A}-option` }, { id: 'nope' }] as never }),
        );

        expect(one.map((r) => r.id)).toEqual([`${A}-option`]);
      });

      /** An OR must not reach past the tenant predicate. */
      it('where — array cannot reach another tenant', async () => {
        const rows = await asTenant(A, () =>
          options.find({ where: [{ id: `${A}-option` }, { id: `${B}-option` }] as never }),
        );

        expect(rows.map((r) => r.id)).toEqual([`${A}-option`]);
      });

      /**
       * `In([...])` previously produced `= '[object Object]'`, which returned
       * nothing — right by accident. `Not()` and `IsNull()` would each have been
       * wrong in a different direction.
       */
      it('where — a FindOperator is expanded, not stringified', async () => {
        const matched = await asTenant(A, () =>
          options.find({ where: { id: In([`${A}-option`, 'nope']) } as never }),
        );

        expect(matched.map((r) => r.id)).toEqual([`${A}-option`]);

        const negated = await asTenant(A, () =>
          options.find({ where: { key: Not('size') } as never }),
        );

        expect(negated).toHaveLength(0);
      });

      it('order sorts within the tenant', async () => {
        const rows = await asTenant(A, () => options.find({ order: { key: 'DESC' } }));

        expect(rows).toHaveLength(1);
      });

      it('select returns the named columns', async () => {
        const rows = await asTenant(A, () =>
          options.find({ select: { id: true, key: true } as never }),
        );

        expect(rows[0].id).toBe(`${A}-option`);
        expect(rows[0].key).toBe('size');
      });

      it('skip and take paginate within the tenant', async () => {
        const page = await asTenant(A, () => options.find({ take: 1, skip: 0 }));

        expect(page).toHaveLength(1);
      });
    });

    describe('refused', () => {
      /**
       * Refused loudly rather than ignored. `relations` returning an entity with
       * the field simply absent gives a caller no way to tell "not loaded" from
       * "no rows".
       */
      it.each([
        ['relations', { relations: { optionSet: true } }],
        ['withDeleted', { withDeleted: true }],
        ['cache', { cache: true }],
        ['lock', { lock: { mode: 'pessimistic_read' } }],
        ['loadEagerRelations', { loadEagerRelations: true }],
        ['loadRelationIds', { loadRelationIds: true }],
        ['comment', { comment: 'x' }],
        ['transaction', { transaction: true }],
      ])('%s throws rather than being dropped', async (name, option) => {
        await expect(asTenant(A, () => options.find(option as never))).rejects.toThrow(
          new RegExp(`does not support: ${name}`),
        );
      });

      /** The message says what to do instead. */
      it('names the supported options in the error', async () => {
        await expect(
          asTenant(A, () => options.find({ relations: {} as never })),
        ).rejects.toThrow(/Supported: where, order, skip, take, select/);
      });
    });
  });

  describe('without a tenant context', () => {
    /**
     * The M6.4 acceptance criterion, extended to these entities: a method that
     * forgets scoping cannot leak — it throws.
     */
    it('throws rather than returning every row', async () => {
      await expect(groups.find()).rejects.toThrow(/No tenant in the request context/);
      await expect(options.count()).rejects.toThrow(/No tenant in the request context/);
      await expect(values.findById('anything')).rejects.toThrow(
        /No tenant in the request context/,
      );
    });
  });
});
