import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AssignmentView } from '@/lib/option-sets/api';
import type { Product } from '@/lib/products/api';
import { AssignedRow, EmptyCatalogue, ProductRow } from './product-display';

/**
 * What the shared product row renders, asserted as output.
 *
 * These are the two rules that **drifted while duplicated** (L2): the identity
 * line printed `#1042` on one screen and `1042` on the other, and a product with
 * no single price showed `—` on one and nothing on the other. Neither difference
 * was visible in development, because the seeded catalogue has no null price and
 * no null SKU — they would have surfaced first against a real catalogue holding a
 * variable product. A source guard can check that the *code* says `'—'`; only a
 * render can check that a merchant sees it.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const PRODUCT: Product = {
  id: 'ours-uuid',
  externalId: '1042',
  name: 'Custom Hoodie',
  sku: 'HOOD-1',
  type: 'simple',
  priceMinor: 1799,
  status: 'publish',
  permalink: null,
  imageUrl: null,
};

describe('ProductRow', () => {
  /**
   * The selection slot (M19.5).
   *
   * 🔴 **Rendered only when given.** `ProductRow` is used on screens where
   * nothing is selectable, and a checkbox appearing there would offer an action
   * that does nothing. Both halves are asserted, because "renders when passed"
   * alone passes for a component that always renders one.
   */
  it('renders a selection control only when one is given', () => {
    expect(html(<ProductRow product={PRODUCT} />)).not.toContain('type="checkbox"');

    expect(
      html(<ProductRow product={PRODUCT} select={<input type="checkbox" readOnly />} />),
    ).toContain('type="checkbox"');
  });

  it('still names the product when a selection control is present', () => {
    const output = html(
      <ProductRow product={PRODUCT} select={<input type="checkbox" readOnly />} />,
    );

    expect(output).toContain('Custom Hoodie');
    expect(output).toContain('HOOD-1');
  });

  it('names the product and its SKU', () => {
    const output = html(<ProductRow product={PRODUCT} />);

    expect(output).toContain('Custom Hoodie');
    expect(output).toContain('HOOD-1');
  });

  /** `#` marks it as an identifier: a bare number reads as a quantity or a price. */
  it('falls back to the WooCommerce id, marked as an id', () => {
    const output = html(<ProductRow product={{ ...PRODUCT, sku: null }} />);

    expect(output).toContain('#1042');
  });

  it('formats the price from minor units', () => {
    expect(html(<ProductRow product={PRODUCT} />)).toContain('17.99');
  });

  /**
   * 🔴 `null` is "it depends" — a variable product priced by its variations —
   * not "free". `£0.00` would be a lie a merchant cannot tell from a broken
   * import, and blank reads as a rendering fault.
   */
  it('shows an em dash rather than a price it does not have', () => {
    const output = html(<ProductRow product={{ ...PRODUCT, priceMinor: null }} />);

    expect(output).toContain('—');
    expect(output).not.toContain('0.00');
  });

  /** A product that is not `publish` cannot be bought, so an option on it renders nowhere. */
  it('names a status that is not published', () => {
    expect(html(<ProductRow product={{ ...PRODUCT, status: 'draft' }} />)).toContain('draft');
  });

  it('stays quiet about a published one', () => {
    expect(html(<ProductRow product={PRODUCT} />)).not.toContain('publish<');
  });

  it('shows a type that is not simple', () => {
    expect(html(<ProductRow product={{ ...PRODUCT, type: 'variable' }} />)).toContain('variable');
  });

  it('renders the action it is given', () => {
    const output = html(<ProductRow product={PRODUCT} action={<button>ASSIGN</button>} />);

    expect(output).toContain('ASSIGN');
  });

  /** Merchant text is unbounded; `truncate` needs `min-w-0` to do anything in a flex row. */
  it('keeps long names inside a shrinkable column', () => {
    const output = html(<ProductRow product={{ ...PRODUCT, name: 'x'.repeat(300) }} />);

    expect(output).toContain('min-w-0');
    expect(output).toContain('truncate');
  });
});

describe('EmptyCatalogue', () => {
  /**
   * 🔴 A fresh store's catalogue is empty because **the store has not pushed it
   * yet** — M19.1 does that, on a quarter-hourly schedule. "No products found"
   * reads as a bug or a failed load, and the difference decides whether a
   * merchant waits or files a ticket.
   *
   * ✏️ This said *"nothing has imported it yet"* until M19.1 shipped. ADR-067
   * had already withdrawn the import: the **store pushes**, because the cloud
   * holds no WooCommerce credentials and AC8 forbids it.
   */
  it('explains that the store has not pushed its catalogue yet', () => {
    const output = html(<EmptyCatalogue searching={false} />);

    expect(output).toContain('arrived from your store');
    expect(output).not.toContain('starts with');
  });

  /**
   * ⚠️ **And it says where to look.** A merchant told to wait on a process they
   * cannot see has nothing to do but file a ticket; the plugin's System Status
   * carries a row that answers the question directly.
   */
  it('points at the System Status row that shows the sync', () => {
    const output = html(<EmptyCatalogue searching={false} />);

    expect(output).toContain('System Status');
    expect(output).toContain('Catalogue sync');
  });

  /** The catalogue matches `LIKE 'term%'`, so "Board" finds nothing while three contain it. */
  it('explains a fruitless search as a prefix match', () => {
    const output = html(<EmptyCatalogue searching />);

    expect(output).toContain('starts with');
    expect(output).not.toContain('not been imported yet');
  });
});

/**
 * What one current assignment renders (M19.1').
 *
 * 🔴 **The "No longer in your catalogue" warning is product-only, and this is
 * the test that says so.** `productName` is joined from `store_products`, so it
 * is `null` for **every** category, tag, attribute and price band — nothing else
 * is in that table. Before this was fixed, making non-product targets authorable
 * would have shown every correct category assignment as broken from the first
 * render. A source guard cannot catch that; only asserting the output can.
 */
describe('AssignedRow', () => {
  const row = (over: Partial<AssignmentView> = {}): AssignmentView => ({
    id: 'a-1',
    mode: 'manual',
    targetType: 'product',
    targetRef: '1042',
    priority: 0,
    productName: 'Custom Hoodie',
    productStatus: 'publish',
    ...over,
  });

  const render = (assignment: AssignmentView) =>
    html(<AssignedRow row={assignment} canAssign isBusy={false} onRemove={() => {}} />);

  it('names an assigned product', () => {
    expect(render(row())).toContain('Custom Hoodie');
  });

  it('warns when an assigned product has left the catalogue', () => {
    const output = render(row({ productName: null, productStatus: null }));

    expect(output).toContain('No longer in your catalogue');
  });

  it('warns when an assigned product is not published', () => {
    expect(render(row({ productStatus: 'draft' }))).toContain('not visible on your storefront');
  });

  /* 🔴 The defect: a category has no `productName` and is not broken. */
  it('does not call a category assignment missing from the catalogue', () => {
    const output = render(
      row({ targetType: 'category', targetRef: 'summer', productName: null, productStatus: null }),
    );

    expect(output).not.toContain('No longer in your catalogue');
    expect(output).toContain('summer');
  });

  /* Two rows reading `summer` are indistinguishable without the type named. */
  it('names the target type for a non-product assignment', () => {
    const output = render(
      row({ targetType: 'tag', targetRef: 'summer', productName: null, productStatus: null }),
    );

    expect(output).toContain('Tag');
  });

  /*
   * An assignment written before target types were authorable has a null
   * `targetType`, and it means `product` — the only thing that could be written.
   */
  it('treats a row with no target type as a product', () => {
    const output = render(row({ targetType: null, productName: null, productStatus: null }));

    expect(output).toContain('No longer in your catalogue');
  });
});
