import type { Product } from '@/lib/products/api';
import { SAMPLE_BASE_MINOR } from '@/lib/option-sets/sample-total';

/**
 * The price a preview computes against, and what it can honestly say about it.
 *
 * 🔴 **A percentage is meaningless without its base**, so the preview states
 * one every time it states a total (ADR-107, following M20.6's worked example:
 * *"a number a merchant mistakes for 'what my customer pays' is worse than no
 * number"*).
 *
 * ⚠️ **A real product's price is a MIRROR, not a quote.** `StoreProduct` is
 * blunt about it — *"Never a source of truth… the plugin always uses
 * WooCommerce's live price, because a cached price shown at checkout would be a
 * customer charged the wrong amount"* — and the catalogue is push-driven
 * (ADR-067), so the cloud cannot refresh it on demand. A preview is not a
 * checkout, so mirroring is fine; presenting it as a live quote is not.
 */
export interface PreviewBase {
  /** What to price against, in minor units. */
  readonly baseMinor: number;
  /** What to tell the merchant this number is. */
  readonly description: string;
  /** Whether this is a real product's price rather than the stated sample. */
  readonly fromProduct: boolean;
}

/**
 * ✅ **A variable product needs no special case, which is the surprise.**
 *
 * ADR-101 was written as *"preview against the lowest variant price"*, implying
 * a computation. There is none to do: `CataloguePayload::price_minor()` pushes
 * `WC_Product::get_price()`, and for a variable product WooCommerce **already**
 * returns the minimum variation price. Measured — *Test Variable Tee* has a
 * range of 2000–3000 and pushes **2000**. The backend stores no variant data at
 * all, so there was never anything here to compute.
 *
 * `priceMinor === null` therefore means **no price is set**, not "this product
 * is variable".
 *
 * @param product The product a merchant chose, or null for none.
 */
export function previewBase(product: Product | null): PreviewBase {
  if (product === null || product.priceMinor === null) {
    return {
      baseMinor: SAMPLE_BASE_MINOR,
      /*
       * Named as a sample, because a set with no assignment yet — *"every set
       * while it is being written"* — still needs an example to show, and a
       * merchant must be able to tell an example from their own catalogue.
       */
      description:
        product === null
          ? 'a sample product price'
          : `a sample price, because ${product.name} has none set`,
      fromProduct: false,
    };
  }

  return {
    baseMinor: product.priceMinor,
    /*
     * "as last synced" rather than a bare price: the number is a mirror of the
     * store's last catalogue push, and the cloud cannot ask for a fresher one.
     */
    description: `${product.name}, as last synced from your store`,
    fromProduct: true,
  };
}

/**
 * Whether the storefront would render options on this product at all.
 *
 * 🔴 **The catalogue pushes every product type; the storefront renders two.**
 * `Renderer::SUPPORTED_TYPES` is `['simple', 'variable']`, so an `external` or
 * `grouped` product can be chosen here, priced here, and show a customer
 * nothing. The live test store has one of each.
 */
export function rendersOptions(product: Product | null): boolean {
  return product === null || product.type === 'simple' || product.type === 'variable';
}
