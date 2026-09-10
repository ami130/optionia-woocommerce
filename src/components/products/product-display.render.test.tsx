import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Product } from '@/lib/products/api';
import { EmptyCatalogue, ProductRow } from './product-display';

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
   * 🔴 A fresh store's catalogue is empty because **nothing has imported it yet**
   * — M19.1 does that. "No products found" reads as a bug or a failed load, and
   * the difference decides whether a merchant waits or files a ticket.
   */
  it('names the pending import when nothing is searched', () => {
    const output = html(<EmptyCatalogue searching={false} />);

    expect(output).toContain('not been imported yet');
    expect(output).not.toContain('starts with');
  });

  /** The catalogue matches `LIKE 'term%'`, so "Board" finds nothing while three contain it. */
  it('explains a fruitless search as a prefix match', () => {
    const output = html(<EmptyCatalogue searching />);

    expect(output).toContain('starts with');
    expect(output).not.toContain('not been imported yet');
  });
});
