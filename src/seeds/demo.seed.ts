import type { DataSource } from 'typeorm';

import { OptionGroup } from '../option-sets/entities/option-group.entity';
import { OptionSet } from '../option-sets/entities/option-set.entity';
import { OptionSetAssignment } from '../option-sets/entities/option-set-assignment.entity';
import { OptionSetVersion } from '../option-sets/entities/option-set-version.entity';
import { OptionValue } from '../option-sets/entities/option-value.entity';
import { Option } from '../option-sets/entities/option.entity';
import { OrderEvent } from '../orders/entities/order-event.entity';
import { OrderSelection } from '../orders/entities/order-selection.entity';
import { Plan } from '../plans/entities/plan.entity';
import { Store } from '../stores/entities/store.entity';
import { StoreProduct } from '../products/entities/store-product.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import {
  AssignmentMode,
  Cardinality,
  GroupDisplayType,
  OptionSetStatus,
  Presentation,
  PriceType,
  StorePlatform,
  StoreStatus,
  ValueKind,
} from '../common/database/enums';
import { OptionSetSerializer } from '../option-sets/serialization/option-set.serializer';
import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { report } from './seed-context';

/**
 * A realistic merchant, for development and E2E.
 *
 * The volume matters more than it sounds. Without it every developer builds
 * against three hand-typed records, and the screens that break under real
 * data — analytics, the product picker, a large builder — break for the first
 * time in front of a merchant.
 *
 * ⚠️ **Option types are deliberately limited to `radio`.**
 *
 * M5.10 asks for "4 option sets covering every shipped option type". Zero option
 * types have shipped: the registry is Phase 7 (radio) and Phase 14 (the rest).
 * `presentation` is currently a `VARCHAR` with no validator, renderer or pricing
 * behaviour behind it.
 *
 * Seeding `presentation: 'date_picker'` would be a claim the code cannot honour —
 * the same failure as a script pointing at a file that does not exist. Phase 14
 * extends this fixture as each type becomes real.
 */

/** Deterministic, so the fixture is identical on every machine and in CI. */
const SEED_TENANT_SLUG = 'demo-merchant';
const SEED_STORE_URL = 'https://demo.optionia.test';

/**
 * A tiny seeded PRNG.
 *
 * `Math.random()` would make the fixture different on every run, so an E2E test
 * asserting "the top-selling value is X" would pass locally and fail in CI for
 * no reason a developer could reproduce.
 */
function makeRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;

    return state / 4_294_967_296;
  };
}

const PRODUCT_NAMES = [
  'Classic Tee',
  'Heavyweight Hoodie',
  'Canvas Tote',
  'Enamel Mug',
  'Leather Keyring',
  'Oak Serving Board',
  'Linen Apron',
  'Ceramic Planter',
  'Wool Scarf',
  'Cork Coaster Set',
];

interface OptionSetSpec {
  name: string;
  group: string;
  optionKey: string;
  optionLabel: string;
  values: Array<{ key: string; label: string; priceMinor: number }>;
}

/**
 * Four option sets, each one radio option.
 *
 * Chosen to span the pricing shapes analytics needs to distinguish: a free
 * choice, a cheap add-on, a premium upgrade, and one where every value costs
 * something.
 */
const OPTION_SETS: OptionSetSpec[] = [
  {
    name: 'Print Placement',
    group: 'Customisation',
    optionKey: 'print_placement',
    optionLabel: 'Print placement',
    values: [
      { key: 'none', label: 'None', priceMinor: 0 },
      { key: 'front', label: 'Front', priceMinor: 1000 },
      { key: 'back', label: 'Back', priceMinor: 1000 },
      { key: 'both', label: 'Front and back', priceMinor: 1800 },
    ],
  },
  {
    name: 'Gift Options',
    group: 'Gifting',
    optionKey: 'gift_wrap',
    optionLabel: 'Gift wrapping',
    values: [
      { key: 'none', label: 'No wrapping', priceMinor: 0 },
      { key: 'standard', label: 'Standard wrap', priceMinor: 500 },
      { key: 'premium', label: 'Premium wrap', priceMinor: 1200 },
    ],
  },
  {
    name: 'Finish',
    group: 'Materials',
    optionKey: 'finish',
    optionLabel: 'Finish',
    values: [
      { key: 'standard', label: 'Standard', priceMinor: 0 },
      { key: 'matte', label: 'Matte', priceMinor: 800 },
      { key: 'gloss', label: 'Gloss', priceMinor: 800 },
      { key: 'luxury', label: 'Luxury', priceMinor: 2000 },
    ],
  },
  {
    name: 'Engraving Tier',
    group: 'Personalisation',
    optionKey: 'engraving_tier',
    optionLabel: 'Engraving',
    values: [
      { key: 'initials', label: 'Initials', priceMinor: 900 },
      { key: 'name', label: 'Full name', priceMinor: 1500 },
      { key: 'message', label: 'Short message', priceMinor: 2500 },
    ],
  },
];

const PRODUCT_COUNT = 30;
const ORDER_COUNT = 50;

/**
 * Options in the builder stress-test set.
 *
 * A builder that feels responsive with four options is the reason M28.5 requires
 * testing with a hundred. Without a large set in the fixture, the first person
 * to notice the builder crawling is a merchant with a real made-to-order product.
 */
const STRESS_OPTION_COUNT = 40;

/**
 * Build the demo tenant.
 *
 * Idempotent by deletion: an existing demo tenant is removed and rebuilt, so
 * re-running produces the same fixture rather than accumulating rows. Safe
 * because the tenant is identified by a slug no real merchant would use, and
 * `openSeedConnection` already refuses to run in production.
 */
export async function seedDemo(dataSource: DataSource): Promise<void> {
  const random = makeRandom(20_260_824);

  await resetExistingDemo(dataSource);

  const plan = await dataSource.getRepository(Plan).findOne({ where: { code: 'pro' } });

  if (!plan) {
    // findOneOrFail would say `Could not find any entity of type "Plan"`, which
    // tells a developer nothing about what to do next.
    throw new Error(
      'No "pro" plan found. Run `npm run db:seed` first — the demo tenant needs a ' +
        'plan to subscribe to.',
    );
  }

  const tenant = await dataSource.getRepository(Tenant).save(
    dataSource.getRepository(Tenant).create({
      name: 'Demo Merchant',
      slug: SEED_TENANT_SLUG,
      planId: plan.id,
    }),
  );

  const store = await dataSource.getRepository(Store).save(
    dataSource.getRepository(Store).create({
      tenantId: tenant.id,
      platform: StorePlatform.WOOCOMMERCE,
      name: 'Demo Storefront',
      storeUrl: SEED_STORE_URL,
      status: StoreStatus.CONNECTED,
      connectedAt: new Date(),
      lastSeenAt: new Date(),
      pluginVersion: '0.1.0',
      wpVersion: '7.1',
      wcVersion: '11.0.1',
      phpVersion: '8.4',
      configVersion: 1,
    }),
  );

  report('tenant + store', 2, 0);

  const products = await seedProducts(dataSource, store.id, random);
  const sets = await seedOptionSets(dataSource, tenant.id, store.id, products);

  await seedStressOptionSet(dataSource, tenant.id, store.id);
  await seedOrders(dataSource, store.id, products, random);

  report('option sets', sets + 1, 0);
}

/** Remove a previous demo tenant so re-running rebuilds rather than accumulates. */
async function resetExistingDemo(dataSource: DataSource): Promise<void> {
  const existing = await dataSource
    .getRepository(Tenant)
    .findOne({ where: { slug: SEED_TENANT_SLUG } });

  if (!existing) {
    return;
  }

  // Stores are RESTRICT-protected against tenant deletion, and order_events are
  // RESTRICT-protected against store deletion — both deliberate (ADR: financial
  // records must not vanish with a disconnect). Unwind in dependency order
  // rather than weakening the constraints.
  const stores = await dataSource.getRepository(Store).find({ where: { tenantId: existing.id } });

  for (const store of stores) {
    const events = await dataSource
      .getRepository(OrderEvent)
      .find({ where: { storeId: store.id } });

    for (const event of events) {
      await dataSource.getRepository(OrderSelection).delete({ orderEventId: event.id });
    }

    await dataSource.getRepository(OrderEvent).delete({ storeId: store.id });
    await dataSource.getRepository(StoreProduct).delete({ storeId: store.id });
  }

  // Option sets cascade to groups, options and values.
  await dataSource.getRepository(OptionSet).delete({ tenantId: existing.id });
  await dataSource.getRepository(Store).delete({ tenantId: existing.id });
  await dataSource.getRepository(Tenant).delete({ id: existing.id });
}

async function seedProducts(
  dataSource: DataSource,
  storeId: string,
  random: () => number,
): Promise<StoreProduct[]> {
  const repository = dataSource.getRepository(StoreProduct);
  const products: StoreProduct[] = [];

  for (let index = 0; index < PRODUCT_COUNT; index += 1) {
    const base = PRODUCT_NAMES[index % PRODUCT_NAMES.length];
    const variant = Math.floor(index / PRODUCT_NAMES.length) + 1;

    products.push(
      repository.create({
        storeId,
        externalId: String(1000 + index),
        name: variant > 1 ? `${base} (v${variant})` : base,
        sku: `DEMO-${String(index + 1).padStart(3, '0')}`,
        type: index % 7 === 0 ? 'variable' : 'simple',
        priceMinor: 1500 + Math.floor(random() * 8500),
        status: 'publish',
        permalink: `${SEED_STORE_URL}/product/demo-${index + 1}`,
        /*
         * 🔴 **Slugs, because that is what the plugin sends.**
         * `CataloguePayload::terms()` builds its list from `$term->slug` --
         * *"a slug is what `has_term()` takes, so it is what an assignment must
         * carry"* -- and a taxonomy assignment stores the slug too. Seeding the
         * **display** name here (`Apparel`) made every category feature pass
         * against seeded data and fail against a real store, because
         * `JSON_CONTAINS(categories, '"apparel"')` matches one and not the
         * other. Verified against a plugin-pushed row: `["uncategorized"]`.
         */
        categories: [index % 3 === 0 ? 'apparel' : 'homeware'],
        tags: index % 4 === 0 ? ['personalised'] : [],
        syncedAt: new Date(),
      }),
    );
  }

  const saved = await repository.save(products);
  report('products', saved.length, 0);

  return saved;
}

async function seedOptionSets(
  dataSource: DataSource,
  tenantId: string,
  storeId: string,
  products: StoreProduct[],
): Promise<number> {
  const sets = dataSource.getRepository(OptionSet);
  const groups = dataSource.getRepository(OptionGroup);
  const options = dataSource.getRepository(Option);
  const values = dataSource.getRepository(OptionValue);
  const assignments = dataSource.getRepository(OptionSetAssignment);
  const versions = dataSource.getRepository(OptionSetVersion);

  /**
   * The same serializer the publish path uses, so a seeded snapshot and a real
   * one cannot describe the published shape differently.
   */
  const serializer = new OptionSetSerializer();

  /**
   * The options of a group, with their values, in the order the tree expects.
   *
   * Read back rather than accumulated in memory: the loop below creates options
   * in several branches (the seasonal one only for the first set), and building
   * the list by hand would mean remembering to append in each of them — exactly
   * the kind of bookkeeping that silently omits a row from the snapshot.
   */
  const optionsOf = async (optionGroupId: string) => {
    const rows = await options.find({
      where: { optionGroupId, deletedAt: LIVE_SENTINEL_SQL as never },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });

    return Promise.all(
      rows.map(async (option) => ({
        option,
        values: await values.find({
          where: { optionId: option.id, deletedAt: LIVE_SENTINEL_SQL as never },
          order: { sortOrder: 'ASC', id: 'ASC' },
        }),
      })),
    );
  };

  for (const [index, spec] of OPTION_SETS.entries()) {
    const set = await sets.save(
      sets.create({
        tenantId,
        storeId,
        name: spec.name,
        status: OptionSetStatus.PUBLISHED,
        version: 1,
        rowVersion: 1,
        publishedAt: new Date(),
        publishedConfigVersion: 1,
      }),
    );

    const group = await groups.save(
      groups.create({
        optionSetId: set.id,
        label: spec.group,
        displayType: GroupDisplayType.INLINE,
        sortOrder: 0,
      }),
    );

    const option = await options.save(
      options.create({
        optionGroupId: group.id,
        key: spec.optionKey,
        valueKind: ValueKind.CHOICE,
        cardinality: Cardinality.ONE,
        presentation: Presentation.RADIO,
        label: spec.optionLabel,
        isRequired: true,
        sortOrder: 0,
      }),
    );

    await values.save(
      spec.values.map((value, position) =>
        values.create({
          optionId: option.id,
          valueKey: value.key,
          label: value.label,
          sortOrder: position,
          priceType: PriceType.FIXED,
          priceAmountMinor: value.priceMinor,
          isDefault: position === 0,
        }),
      ),
    );

    /**
     * The first set carries a disabled option and a disabled value.
     *
     * Nothing in the fixture exercised `is_enabled` — all 186 rows were enabled,
     * so a serializer that ignored the flag entirely would produce a config
     * document identical to a correct one. M7.2's escape hatch would have been
     * tested only by code written to test it, never by the data everyone
     * develops against.
     *
     * One set rather than all five: enough that the published projection has
     * something to exclude, few enough that the demo still looks like a working
     * store rather than a half-configured one.
     */
    if (index === 0) {
      const seasonal = await options.save(
        options.create({
          optionGroupId: group.id,
          key: 'gift_wrap',
          valueKind: ValueKind.CHOICE,
          cardinality: Cardinality.ONE,
          presentation: Presentation.RADIO,
          label: 'Gift wrapping (off-season)',
          isRequired: false,
          sortOrder: 1,
          // Turned off for the holidays, retained in full — the case M7.2 names.
          isEnabled: false,
        }),
      );

      await values.save([
        values.create({
          optionId: seasonal.id,
          valueKey: 'none',
          label: 'No wrapping',
          sortOrder: 0,
          priceType: PriceType.FIXED,
          priceAmountMinor: 0,
          isDefault: true,
        }),
        values.create({
          optionId: seasonal.id,
          valueKey: 'premium',
          label: 'Premium paper',
          sortOrder: 1,
          priceType: PriceType.FIXED,
          priceAmountMinor: 500,
        }),
      ]);

      // A disabled value inside an *enabled* option, so the two levels are
      // exercised independently rather than only in combination.
      await values.save(
        values.create({
          optionId: option.id,
          valueKey: 'discontinued',
          label: 'Discontinued finish',
          sortOrder: spec.values.length,
          priceType: PriceType.FIXED,
          priceAmountMinor: 0,
          isEnabled: false,
        }),
      );
    }

    /**
     * 🔴 **The snapshot, without which a "published" set is unservable.**
     *
     * This seed used to mark sets `PUBLISHED` and write `publishedAt` while
     * creating **no** `option_set_versions` row — a state the publish path can
     * never produce, because it writes both in one transaction.
     *
     * `config-document.ts` builds a storefront's configuration by looking each
     * published set up as `optionSetId:version` in that table, and **skips**
     * what it cannot find (deliberately: one corrupt set must not take a whole
     * storefront down). So every seeded set was silently absent — a demo showed
     * five published option sets and the storefront rendered none of them.
     *
     * Measured before this fix: 4 published sets with zero version rows.
     *
     * 📌 **Serialized by the real serializer, not by hand.** A hand-written
     * snapshot is a second definition of the published shape that drifts the
     * first time a field is added — which is the whole reason `toPublished`
     * lists every field explicitly.
     */
    await versions.save(
      versions.create({
        optionSetId: set.id,
        version: set.version,
        snapshot: {
          ...serializer.toPublished({
            set,
            rules: [],
            groups: [
              {
                group,
                items: [],
                options: await optionsOf(group.id),
              },
            ],
          }),
          version: set.version,
        } as unknown as Record<string, unknown>,
        publishedBy: null,
        publishedAt: set.publishedAt ?? new Date(),
        note: 'Seeded demo data.',
      }),
    );

    // The first set covers everything; the rest target a slice of the catalogue,
    // so assignment resolution has overlapping cases to exercise.
    if (index === 0) {
      await assignments.save(
        assignments.create({ optionSetId: set.id, mode: AssignmentMode.ALL, priority: 0 }),
      );
    } else {
      const slice = products.slice(index * 5, index * 5 + 5);

      await assignments.save(
        slice.map((product) =>
          assignments.create({
            optionSetId: set.id,
            mode: AssignmentMode.MANUAL,
            targetType: 'product' as const,
            targetRef: product.externalId,
            priority: index,
          }),
        ),
      );
    }
  }

  return OPTION_SETS.length;
}

/**
 * A deliberately large option set, for builder performance.
 *
 * Not assigned to any product: its purpose is to load the builder, not to render
 * on a storefront. Kept as a draft so it cannot reach the config document.
 */
async function seedStressOptionSet(
  dataSource: DataSource,
  tenantId: string,
  storeId: string,
): Promise<void> {
  const sets = dataSource.getRepository(OptionSet);
  const groups = dataSource.getRepository(OptionGroup);
  const options = dataSource.getRepository(Option);
  const values = dataSource.getRepository(OptionValue);

  const set = await sets.save(
    sets.create({
      tenantId,
      storeId,
      name: 'Made-to-Order Configuration (large)',
      status: OptionSetStatus.DRAFT,
      version: 0,
      rowVersion: 1,
      publishedConfigVersion: 0,
    }),
  );

  // Four groups, so the fixture also exercises grouping rather than one flat
  // list of forty.
  const groupLabels = ['Dimensions', 'Materials', 'Finishing', 'Delivery'];
  const created: OptionGroup[] = [];

  for (const [index, label] of groupLabels.entries()) {
    created.push(
      await groups.save(
        groups.create({
          optionSetId: set.id,
          label,
          displayType: GroupDisplayType.ACCORDION,
          sortOrder: index,
          isCollapsible: true,
        }),
      ),
    );
  }

  for (let index = 0; index < STRESS_OPTION_COUNT; index += 1) {
    const group = created[index % created.length];

    const option = await options.save(
      options.create({
        optionGroupId: group.id,
        key: `spec_${String(index + 1).padStart(2, '0')}`,
        valueKind: ValueKind.CHOICE,
        cardinality: Cardinality.ONE,
        presentation: Presentation.RADIO,
        label: `Specification ${index + 1}`,
        isRequired: index % 5 === 0,
        sortOrder: index,
      }),
    );

    await values.save(
      Array.from({ length: 3 }, (_unused, position) =>
        values.create({
          optionId: option.id,
          valueKey: `choice_${position + 1}`,
          label: `Choice ${position + 1}`,
          sortOrder: position,
          priceType: PriceType.FIXED,
          priceAmountMinor: position * 500,
          isDefault: position === 0,
        }),
      ),
    );
  }

  report('stress option set', STRESS_OPTION_COUNT, 0);
}

/**
 * Historical orders with option selections.
 *
 * 50 orders producing 100–200 selections is what makes Phase 25's analytics
 * meaningful rather than returning a single row — and what justifies
 * `INDEX (option_key, value_key)`, which looks unnecessary against three rows.
 */
async function seedOrders(
  dataSource: DataSource,
  storeId: string,
  products: StoreProduct[],
  random: () => number,
): Promise<void> {
  const events = dataSource.getRepository(OrderEvent);
  const selections = dataSource.getRepository(OrderSelection);

  let selectionCount = 0;
  const now = Date.now();

  for (let index = 0; index < ORDER_COUNT; index += 1) {
    const product = products[Math.floor(random() * products.length)];
    const perOrder = 2 + Math.floor(random() * 3); // 2–4 selections

    const chosen = Array.from({ length: perOrder }, () => {
      const spec = OPTION_SETS[Math.floor(random() * OPTION_SETS.length)];
      const value = spec.values[Math.floor(random() * spec.values.length)];

      return { spec, value };
    });

    const optionRevenue = chosen.reduce((total, item) => total + item.value.priceMinor, 0);

    // Spread across 90 days so time-series analytics has a curve rather than a
    // spike.
    const occurredAt = new Date(now - Math.floor(random() * 90) * 86_400_000);

    const event = await events.save(
      events.create({
        storeId,
        externalOrderId: String(5000 + index),
        orderTotalMinor: (product.priceMinor ?? 2000) + optionRevenue,
        currency: 'USD',
        optionRevenueMinor: optionRevenue,
        occurredAt,
      }),
    );

    await selections.save(
      chosen.map((item) =>
        selections.create({
          orderEventId: event.id,
          // Denormalized deliberately: an order is a historical fact and must
          // survive the option being renamed or deleted (ADR-016).
          optionKey: item.spec.optionKey,
          optionLabel: item.spec.optionLabel,
          valueKey: item.value.key,
          valueLabel: item.value.label,
          priceDeltaMinor: item.value.priceMinor,
          configVersion: 1,
        }),
      ),
    );

    selectionCount += chosen.length;
  }

  report('orders', ORDER_COUNT, 0);
  report('order selections', selectionCount, 0);
}
