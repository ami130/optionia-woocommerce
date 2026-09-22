import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatAmount } from '@/lib/money/money';
import {
  TARGET_TYPE_LABELS,
  type AssignmentTarget,
  type AssignmentTargetType,
  type AssignmentView,
} from '@/lib/option-sets/api';
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
export function ProductRow({
  product,
  action,
  select,
}: {
  product: Product;
  action?: ReactNode;
  /**
   * An optional selection control, rendered before the name (M19.5).
   *
   * A slot rather than a `selected`/`onSelect` pair: this component is also
   * rendered where nothing is selectable, and an optional callback would put
   * the decision "is this list selectable?" in two places.
   */
  select?: ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-4 p-3 text-sm">
      <span className="flex min-w-0 items-center gap-3">
        {select}
        <span className="min-w-0">
          <span className="block truncate font-medium">{product.name}</span>
          {/* Truncated like the name above it: a SKU is merchant text and can be long. */}
          <span className="text-muted-foreground block truncate text-xs">
            {identity(product)}
            {product.type === 'simple' ? '' : ` · ${product.type}`}
          </span>
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
      <AlertTitle>No products have arrived from your store yet</AlertTitle>
      <AlertDescription>
        {/*
          🔴 **This used to say Optionia "imports" them, and that describes a
          design that was withdrawn.** ADR-067 reversed it: the **store pushes**
          its catalogue, because the cloud holds no WooCommerce credentials and
          AC8 forbids it holding any. The old copy told a merchant the opposite
          of how the system works — as the first thing they read when something
          is wrong.

          ⚠️ **And it named no action.** "Once that has run" leaves a merchant
          waiting on a process they cannot see, start or diagnose. The plugin's
          System Status carries a *Catalogue sync* row that answers exactly
          this, so the honest empty state points at it.
        */}
        Your store sends its products to Optionia every few minutes. A large catalogue arrives in
        batches, so this can take a while the first time. Check{' '}
        <strong>Optionia → System Status</strong> in your WordPress admin: the{' '}
        <em>Catalogue sync</em> row shows whether it has started, how far it has reached, and
        whether it has finished.
      </AlertDescription>
    </Alert>
  );
}

/**
 * One current assignment.
 *
 * For a **product**, the name is joined server-side, so `null` means it is not
 * in the catalogue — deleted upstream, or not yet imported. Saying that plainly
 * is the point: the option has silently stopped rendering while this list still
 * claims it applies, and the WooCommerce id alone would not tell a merchant why.
 *
 * 🔴 **That warning is product-only, and getting it wrong was the defect.**
 * `productName` is joined from `store_products`, so it is `null` for **every**
 * category, tag, attribute and price band — nothing else is in that table. Left
 * as it was, every non-product assignment would have read "No longer in your
 * catalogue" from the moment M19.1' made them authorable: a correct assignment
 * reported as broken, which is worse than no message at all.
 */
export function AssignedRow({
  row,
  canAssign,
  isBusy,
  onRemove,
}: {
  row: AssignmentView;
  canAssign: boolean;
  isBusy: boolean;
  onRemove: (target: AssignmentTarget) => void;
}) {
  /* An older row, written before target types were authorable, means `product`. */
  const targetType = (row.targetType ?? 'product') as AssignmentTargetType;
  const isProduct = targetType === 'product';

  return (
    <li className="flex items-center justify-between gap-3 p-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-medium">{row.productName ?? row.targetRef}</span>

        {isProduct ? (
          row.productName === null ? (
            <span className="text-destructive text-xs">No longer in your catalogue</span>
          ) : row.productStatus !== 'publish' ? (
            <span className="text-muted-foreground text-xs">
              {row.productStatus} — not visible on your storefront
            </span>
          ) : null
        ) : (
          /*
           * ⚠️ Named rather than silent. A merchant who assigned "summer" as a
           * category and again as a tag sees two identical rows otherwise.
           */
          <span className="text-muted-foreground text-xs">
            {TARGET_TYPE_LABELS[targetType] ?? targetType}
          </span>
        )}
      </span>

      {canAssign && row.targetRef !== null ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={isBusy}
          /* The type travels with the reference: `targetRef` is unique only within one. */
          onClick={() => onRemove({ targetType, targetRef: row.targetRef as string })}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}
