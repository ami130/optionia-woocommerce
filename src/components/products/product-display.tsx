import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatAmount } from '@/lib/money/money';
import type { Product } from '@/lib/products/api';

/**
 * How a product looks, defined once for every screen that lists one.
 *
 * ## 🔴 Why this is shared rather than written per screen
 *
 * `/products` and the assignment picker each had their own row, and they had
 * **already drifted** by the time anyone compared them: one printed the
 * WooCommerce id as `#1042` and the other as `1042`; one showed `—` for a
 * product with no single price and the other showed nothing at all.
 *
 * Neither difference was visible in development, because the seeded catalogue
 * has no null price and no null SKU — the drift only surfaces against a real
 * catalogue containing a variable product. Two screens quietly disagreeing about
 * what the same row means is the failure this module exists to prevent.
 */

/**
 * A product's secondary identity line: SKU, or the store's own id.
 *
 * The `#` matters. A bare number reads as a quantity or a price; `#1042` reads
 * as an identifier, which is what a merchant needs when they are matching this
 * row against their WooCommerce admin.
 */
function identity(product: Product): string {
  return product.sku ?? `#${product.externalId}`;
}

/**
 * A product's price, or why there isn't one.
 *
 * `priceMinor` is an **integer in minor units**, and `null` means "it depends" —
 * a variable product whose price comes from its variations. Printing `£0.00`
 * would be a lie a merchant cannot distinguish from a broken import, and
 * printing nothing reads as a rendering fault, so the absence is shown as `—`.
 */
function price(product: Product): string {
  return product.priceMinor === null ? '—' : formatAmount(product.priceMinor);
}

/**
 * One product in a list.
 *
 * `action` is the only thing that varies between screens — the picker puts an
 * **Assign** button there, the catalogue puts nothing — so it is a slot rather
 * than a flag. A boolean prop per screen is how the two copies drifted.
 */
export function ProductRow({ product, action }: { product: Product; action?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 p-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-medium">{product.name}</span>
        {/* Truncated like the name above it: a SKU is merchant text and can be long. */}
        <span className="text-muted-foreground block truncate text-xs">
          {identity(product)}
          {product.type === 'simple' ? '' : ` · ${product.type}`}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-4">
        <span className="tabular-nums">{price(product)}</span>

        {/*
          A product that is not `publish` — draft, private, pending — cannot be
          bought, so an option set assigned to it renders nowhere. Saying the
          status is what distinguishes that from a broken assignment.
        */}
        {product.status === 'publish' ? null : (
          <span className="text-muted-foreground text-xs">{product.status}</span>
        )}

        {action}
      </span>
    </li>
  );
}

/**
 * 🔴 **"No products found" is the wrong empty state for a fresh store.**
 *
 * Nothing in the product writes `store_products` yet — only the demo seed does,
 * and M19.1 fills it for real merchants. So a store connected today opens an
 * empty catalogue, and "no products" reads as a bug or a failed load rather than
 * an import that has not run. That difference decides whether a merchant waits
 * or files a support ticket.
 *
 * The searching case is separate and just as easy to get wrong: the catalogue
 * matches `LIKE 'term%'` — a **prefix** — so "Board" finds nothing while three
 * products contain the word. Saying only "no match" sends a merchant looking for
 * a product they cannot reach that way.
 */
export function EmptyCatalogue({ searching }: { searching: boolean }) {
  if (searching) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-muted-foreground text-sm">
          No product <em>starts with</em> that. Try the first word of its name.
        </p>
      </div>
    );
  }

  return (
    <Alert>
      <AlertTitle>Your catalogue has not been imported yet</AlertTitle>
      <AlertDescription>
        Optionia imports your products from WooCommerce automatically. Once that has run they will
        appear here, ready to assign to an option set.
      </AlertDescription>
    </Alert>
  );
}
