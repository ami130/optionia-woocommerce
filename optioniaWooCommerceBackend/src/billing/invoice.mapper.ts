import { InvoiceStatus } from '../common/database/enums';
import type { Invoice } from './entities/invoice.entity';

/**
 * A provider invoice, translated into this system's vocabulary (M22.C1).
 *
 * 🔴 **This is the piece F94/E5 found missing** — step B was marked done while
 * B3 was unbuilt, so invoices had a table, a CHECK constraint and an entity with
 * nothing able to produce a row for them.
 *
 * ## Why this is a pure function over `unknown`
 *
 * ⚠️ **The input is a webhook payload, which is to say untrusted and unshaped.**
 * `VerifiedWebhook.payload` is deliberately `unknown`: the signature proves
 * Stripe sent it, not that it contains the fields this code expects. Every field
 * is therefore checked rather than cast, and a payload that does not satisfy the
 * contract returns an error instead of a half-populated row.
 *
 * 📌 Nothing Stripe-shaped appears in the output, per the interface's rule that
 * *"the moment `stripe.Subscription` appears in a service signature, the
 * abstraction has already failed."*
 *
 * @module
 */

/**
 * The columns this mapper fills on `invoices`.
 *
 * 🔴 **Tied to the entity by `Pick`, not by matching names carefully.** G4 found
 * the two drifting freely: a column renamed on `Invoice`, or one added and
 * forgotten here, produced no error at all — the e2e test spread this object
 * into `repo.create()` and TypeORM silently ignored anything unrecognised. Now a
 * rename **stops the build**, which is the same bargain
 * `invoice.mapper.contract.spec.ts` strikes with Stripe's own types.
 *
 * ⚠️ `tenantId`, `subscriptionId` and `provider` are deliberately absent: they
 * are the caller's to resolve, and a mapper that invented them would be
 * guessing which tenant a webhook belongs to.
 */
export type MappedInvoiceColumns = Pick<
  Invoice,
  | 'providerInvoiceId'
  | 'status'
  | 'currency'
  | 'subtotalMinor'
  | 'taxMinor'
  | 'totalMinor'
  | 'taxCountry'
  | 'issuedAt'
  | 'paidAt'
  | 'hostedUrl'
>;

/**
 * The columns, plus the two provider ids a caller needs to find the tenant.
 *
 * 📌 **The ids are NOT columns on `invoices`**, and the split is structural so
 * that stays true: a caller destructures them off before saving, and the
 * compiler — not a convention — decides what may reach the row.
 */
export interface MappedInvoice extends MappedInvoiceColumns {
  /** Stripe's customer id, so a caller can find the tenant. Never a tenant id. */
  providerCustomerId: string | null;
  /** Stripe's subscription id, for the same reason. */
  providerSubscriptionId: string | null;
}

/**
 * 📌 **A result, not a throw.** A malformed invoice must not fail the webhook
 * request: Stripe retries anything it cannot deliver, so throwing would turn one
 * bad payload into a retry storm. The caller records the reason and answers 200.
 */
export type MapResult =
  | { ok: true; invoice: MappedInvoice }
  | { ok: false; reason: string };

/** The five states `InvoiceStatus` accepts — Stripe's own words (see enums.ts). */
const KNOWN_STATUSES = new Set<string>(Object.values(InvoiceStatus));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * ⚠️ **Integers only.** These are minor units; a fractional amount means the
 * payload is not what this code thinks it is, and rounding it would invent
 * money. `Number.isSafeInteger` also rejects `NaN`, `Infinity` and the
 * beyond-2^53 values a `bigint` column could otherwise be handed.
 */
function asMinorUnits(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Stripe sends epoch **seconds**; `Date` takes milliseconds. */
function asDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Translate a provider invoice payload.
 *
 * 🔴 **`totalMinor` is taken from the payload and then checked against
 * `subtotal + tax`, not computed from them.** The database holds the same
 * invariant in `ck_invoices_totals` (F92/D2), and a mapper that *derived* the
 * total could never violate it — which would make the constraint untestable and
 * would silently paper over a provider disagreeing with us about what the
 * merchant owes. A mismatch is a mapping failure, surfaced here.
 */
export function mapInvoice(payload: unknown): MapResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'payload is not an object' };
  }

  const providerInvoiceId = asString(payload.id);
  if (providerInvoiceId === null) {
    return { ok: false, reason: 'missing invoice id' };
  }

  const rawStatus = asString(payload.status);
  if (rawStatus === null || !KNOWN_STATUSES.has(rawStatus)) {
    return { ok: false, reason: `unknown invoice status: ${String(payload.status)}` };
  }
  const status = rawStatus as InvoiceStatus;

  const currency = asString(payload.currency);
  if (currency === null || currency.length !== 3) {
    return { ok: false, reason: `invalid currency: ${String(payload.currency)}` };
  }

  const subtotalMinor = asMinorUnits(payload.subtotal);
  const totalMinor = asMinorUnits(payload.total);
  if (subtotalMinor === null || totalMinor === null) {
    return { ok: false, reason: 'subtotal and total must be integer minor units' };
  }

  const taxMinor = sumTaxes(payload.total_taxes);
  if (taxMinor === null) {
    return { ok: false, reason: 'total_taxes must be integer minor amounts' };
  }

  if (totalMinor !== subtotalMinor + taxMinor) {
    return {
      ok: false,
      reason: `totals disagree: ${subtotalMinor} + ${taxMinor} ≠ ${totalMinor}`,
    };
  }

  /*
   * 📌 ADR-115: Stripe Tax reports the country it taxed under. Stored so a tax
   * report can group by jurisdiction without re-deriving it from an address.
   */
  const taxCountry = readTaxCountry(payload);

  return {
    ok: true,
    invoice: {
      providerInvoiceId,
      status,
      // The column is `char(3)`; Stripe sends lowercase, the rest of the system stores upper.
      currency: currency.toUpperCase(),
      subtotalMinor,
      taxMinor,
      totalMinor,
      taxCountry,
      issuedAt: asDate(payload.created),
      /* ⚠️ Only a paid invoice has a payment time, whatever the payload carries. */
      paidAt: status === InvoiceStatus.PAID ? readPaidAt(payload) : null,
      hostedUrl: asString(payload.hosted_invoice_url),
      providerCustomerId: asProviderId(payload.customer),
      providerSubscriptionId: readSubscriptionId(payload),
    },
  };
}

/**
 * Stripe reports the taxed jurisdiction in `customer_address.country`.
 *
 * ⚠️ Two letters or nothing — the column is `char(2)`, and a longer value would
 * be truncated by MySQL into a different country.
 */
function readTaxCountry(payload: Record<string, unknown>): string | null {
  const address = payload.customer_address;
  if (!isRecord(address)) {
    return null;
  }

  const country = asString(address.country);

  return country !== null && country.length === 2 ? country.toUpperCase() : null;
}

/**
 * Sum `total_taxes[].amount`.
 *
 * 🔴 **There is no `invoice.tax` field in this API version** — I wrote one from
 * memory and the compiler rejected it; tax is a list of `TotalTax` entries, each
 * carrying its own `amount`. An absent or empty list means no tax, which is 0.
 *
 * ⚠️ Every entry must be an integer. Skipping a malformed one would understate a
 * figure the tax report sums, which is the silent-wrong-number failure
 * `InvoiceStatus` was typed to prevent.
 */
function sumTaxes(value: unknown): number | null {
  if (value === null || value === undefined) {
    return 0;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  let total = 0;
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }

    const amount = asMinorUnits(entry.amount);
    if (amount === null) {
      return null;
    }

    total += amount;
  }

  return total;
}

/**
 * 🔴 **`paid_at` is nested under `status_transitions`**, not a flat key. The flat
 * spelling I first wrote type-checks against `unknown` forever and yields
 * `undefined`, so every paid invoice would have been stored with `paidAt: null`
 * — a wrong value with no error, found only by asking the compiler.
 */
function readPaidAt(payload: Record<string, unknown>): Date | null {
  const transitions = payload.status_transitions;

  return isRecord(transitions) ? asDate(transitions.paid_at) : null;
}

/**
 * A provider id that may arrive expanded.
 *
 * ⚠️ Stripe sends `customer` as an id string, **or** as the whole object when a
 * request expanded it. Reading only the string would drop the link to the tenant
 * the moment an expansion was added upstream.
 */
function asProviderId(value: unknown): string | null {
  if (typeof value === 'string') {
    return asString(value);
  }

  return isRecord(value) ? asString(value.id) : null;
}

/**
 * 🔴 **`invoice.subscription` does not exist in this API version.** It moved to
 * `parent.subscription_details.subscription`, which is exactly the kind of
 * breaking change behind a dated version that `STRIPE_API_VERSION` pins against
 * — and exactly what an unpinned upgrade would have broken silently.
 */
function readSubscriptionId(payload: Record<string, unknown>): string | null {
  const parent = payload.parent;
  if (!isRecord(parent)) {
    return null;
  }

  const details = parent.subscription_details;

  return isRecord(details) ? asProviderId(details.subscription) : null;
}
