import { describe, expect, it } from 'vitest';

import { SAMPLE_BASE_MINOR } from '@/lib/option-sets/sample-total';
import type { Product } from '@/lib/products/api';

import { previewBase, rendersOptions } from './preview-base';

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1', externalId: '20', name: 'Custom Hoodie', sku: null,
    type: 'simple', priceMinor: 8000, status: 'publish',
    permalink: null, imageUrl: null, ...over,
  }) as Product;

describe('previewBase', () => {
  it('prices against a chosen product', () => {
    expect(previewBase(product())).toEqual({
      baseMinor: 8000,
      description: 'Custom Hoodie, as last synced from your store',
      fromProduct: true,
    });
  });

  /**
   * 🔴 **"as last synced", never a bare price.** `StoreProduct` is display-only
   * — *"a cached price shown at checkout would be a customer charged the wrong
   * amount"* — and the catalogue is push-driven, so the cloud cannot fetch a
   * fresher one. A preview may mirror; it may not imply a live quote.
   */
  it('says the price is a mirror rather than a quote', () => {
    expect(previewBase(product()).description).toContain('as last synced');
  });

  /**
   * ✅ **A variable product needs no special case.** WooCommerce's `get_price()`
   * already returns the minimum variation price, so it arrives as an ordinary
   * number — measured against the live store, 2000 for a 2000–3000 range.
   */
  it('treats a variable product’s price as any other', () => {
    expect(previewBase(product({ type: 'variable', priceMinor: 2000 })).baseMinor).toBe(2000);
  });

  /**
   * `null` means no price is set — **not** "this product is variable", which is
   * what ADR-101 said until it was measured.
   */
  it('falls back to the sample when a product has no price', () => {
    const base = previewBase(product({ priceMinor: null }));

    expect(base.baseMinor).toBe(SAMPLE_BASE_MINOR);
    expect(base.fromProduct).toBe(false);
    expect(base.description).toContain('Custom Hoodie');
  });

  /** Every set has no product while it is being written. */
  it('falls back to the sample when nothing is chosen', () => {
    const base = previewBase(null);

    expect(base.baseMinor).toBe(SAMPLE_BASE_MINOR);
    expect(base.description).toBe('a sample product price');
    expect(base.fromProduct).toBe(false);
  });
});

describe('rendersOptions', () => {
  /**
   * 🔴 **The catalogue pushes every type; the storefront renders two.**
   * `Renderer::SUPPORTED_TYPES` is `['simple', 'variable']`, so a merchant can
   * choose an `external` or `grouped` product, watch the preview price it, and
   * get nothing on the shop. The live test store has one of each.
   */
  it.each(['simple', 'variable'])('renders options on a %s product', (type) => {
    expect(rendersOptions(product({ type }))).toBe(true);
  });

  it.each(['external', 'grouped', 'subscription'])('does not render on a %s product', (type) => {
    expect(rendersOptions(product({ type }))).toBe(false);
  });

  it('says nothing about a product nobody has chosen', () => {
    expect(rendersOptions(null)).toBe(true);
  });
});
