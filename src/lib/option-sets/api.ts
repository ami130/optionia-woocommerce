import { api } from '@/lib/api/client';

import { canonical, describeChanges } from './publish-diff';
import type { SortEntry } from './entries';
import type {
  RuleAction,
  RuleMatchType,
  RuleOperator,
  RuleTargetType,
} from '@/lib/rules/vocabulary';

export type OptionSetStatus = 'draft' | 'published' | 'archived';

/** A set as the list reports it. */
export interface OptionSetSummary {
  id: string;
  storeId: string;
  name: string;
  status: OptionSetStatus;
  version: number;
  /** The optimistic lock. Echoed back on every write — see `updateSet`. */
  rowVersion: number;
  publishedAt: string | null;
  publishedConfigVersion: number;
}

/** The whole authoring tree, from `GET /:id/detail`. */
export interface AuthoringSet extends OptionSetSummary {
  groups: AuthoringGroup[];

  /**
   * The set's conditional rules, as the tree already carries them.
   *
   * 🔴 **`RulesPanel` fetches these separately from `listRules`** — a request
   * for data the detail response already contained. The backend projection's
   * own docblock records the mirror-image mistake being fixed once before: *"a
   * fifth query on every dashboard render whose result was thrown away"*.
   *
   * ⚠️ **M20.6 needs them**, because rules add and remove price: a sample total
   * computed from values alone would disagree with the storefront exactly when
   * a rule fires, which is the case a merchant is checking.
   *
   * 📌 **Optional**, because `duplicateSet` and `createSet` answer with an
   * `OptionSetSummary` that has no tree at all. Required here would force a
   * cast at three call sites that legitimately have neither groups nor rules.
   *
   * ⚠️ **`RulesPanel` still fetches its own copy, deliberately for now.** Its
   * mutations invalidate `['option-set', id, 'rules']`, and repointing them at
   * the tree is a change to that panel's refresh contract — real risk, no
   * bearing on M20.6, which needs only that this field carries the rules a
   * sample total has to honour. Removing the duplicate fetch is its own change.
   */
  rules?: AuthoringRule[];
}

export interface AuthoringGroup {
  id: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isEnabled: boolean;

  /**
   * How the storefront lays this group out: `inline`, `accordion`, `tabs` or
   * `stepped`.
   *
   * ⚠️ **Four values arrive, three can be chosen.** `stepped` renders as
   * `inline` until its own stage (ADR-063), so the picker omits it — but the
   * API may return it for a group authored elsewhere, and the type must say so
   * rather than pretend the value cannot exist.
   */
  displayType: string;

  /**
   * Whether an `inline` group can be folded away.
   *
   * 🔴 **Ignored for every other type** (ADR-059). An accordion is already
   * collapsible and a tab already hides its siblings, so honouring it there
   * would give two fields one job.
   */
  isCollapsible: boolean;
  options: AuthoringOption[];
  /**
   * Headings, paragraphs and dividers (M5.4c).
   *
   * ⚠️ **Not options**, and not merely a display flag on one: they carry no
   * value, no validation and no pricing, and the pricing engine never sees one.
   * They share only `sortOrder`, on the **same scale** as options — which is why
   * the editor lists both in one sequence rather than in two sections.
   *
   * `GET /:id/detail` has always returned this; nothing here read it until the
   * routes that create one existed.
   */
  items: AuthoringItem[];
}

/** The kinds this dashboard can create. */
export type ItemKind = 'heading' | 'paragraph' | 'divider';

export interface AuthoringItem {
  id: string;
  /**
   * ⚠️ Typed wider than `ItemKind` deliberately.
   *
   * `rich_text` exists in the API's enum and is refused by its DTO until the
   * sanitizer M5.4c requires is built. A set authored by a future release could
   * still carry one, and a narrow type here would make that a runtime surprise
   * in a `switch`. The editor renders an unknown kind read-only rather than
   * pretending it can edit it.
   */
  kind: ItemKind | string;
  content: string;
  sortOrder: number;
  /**
   * Per-kind display configuration (M21c.5, ADR-113).
   *
   * Only `divider` carries anything today — a `style` of `solid`, `dashed` or
   * `dotted`. The API validates it with a `.strict()` schema per kind, so an
   * unknown key is a refusal rather than a silent store.
   *
   * ✏️ **Absent from this interface until 2026-09-22 (F35).** The field was
   * published and the preview could not see it, so a merchant choosing `dashed`
   * saw a solid rule in the preview and a dashed one on the shop.
   */
  display?: Record<string, unknown> | null;
}

export interface AuthoringOption {
  id: string;
  key: string;
  label: string;
  presentation: string;
  isRequired: boolean;
  sortOrder: number;
  isEnabled: boolean;

  /**
   * The wording a customer reads beside this option.
   *
   * 🔴 **All four arrive from the API and none was declared**, so the storefront
   * rendered `help_text`, `placeholder` and `description` that no merchant could
   * set — the same type-boundary defect as `priceConfig` and `pricing`, found by
   * auditing every projection rather than the one being worked on.
   *
   * 📌 **`description` above the field, `helpText` below it**, matching what the
   * plugin's templates draw. Two fields rather than one because they answer
   * different questions: what this option is, and how to fill it in.
   */
  description?: string | null;
  placeholder?: string | null;
  helpText?: string | null;

  /** What the field starts with. Customer-editable, unlike a value's default. */
  defaultValue?: string | null;

  /**
   * The limits a customer's answer must satisfy.
   *
   * 🔴 **The storefront enforces these and no merchant could set them**, so a
   * help text reading "Up to 20 characters" enforced nothing. Advisory wording
   * with no rule behind it is worse than neither.
   *
   * ⚠️ **Structured per option type** — `minLength`/`maxLength` for text,
   * `min`/`max`/`step` for numbers, and for text also `pattern`,
   * `allowedCharset` and `blocklist`. The editor authors the bounds only; the
   * rest must **survive** an edit, because the schemas are `.strict()` and an
   * omitted field is a deleted one.
   */
  validation?: Record<string, unknown> | null;

  /**
   * How this option is drawn.
   *
   * ⚠️ **One field here is DERIVED, not chosen.** `character_counter` follows
   * the length limit — `text_field.php` says the dashboard must derive it *"so
   * the two cannot disagree"*, and the template checks both because an older
   * dashboard could publish one without the other.
   *
   * 📌 Structured per option type: `columns` and `swatchSize` for the choice
   * types, `characterCounter` for text, with `priceDisplay`, `tooltip` and
   * `collapsedByDefault` shared.
   */
  display?: Record<string, unknown> | null;

  /**
   * How this **option** is priced, for the types that price per option.
   *
   * 🔴 **The API has always sent it; this type dropped it** — the same defect as
   * `priceConfig` on a value, one level up. The projection carries twenty fields
   * per option and this interface declared eight.
   *
   * 📌 **Only the option-level types use it.** A choice option prices per value
   * (`noTypeLevelPricing` refuses anything here); a text option prices
   * `per_char`; a number option prices `per_unit` or `tiered`. The type registry
   * decides which, and the API validates against it.
   *
   * ⚠️ **The STORED shape — `amountMinor`, `freeCharacters`, `minQuantity`.**
   * `toPublishedPriceConfig` converts to the wire shape the plugin reads.
   */
  pricing?: Record<string, unknown> | null;

  values: AuthoringValue[];
}

export interface AuthoringValue {
  id: string;
  valueKey: string;
  label: string;
  sortOrder: number;
  priceType: string;
  priceAmountMinor: number;
  /** `<optgroup>` heading. `null` when the value is not grouped. */
  groupLabel?: string | null;
  /**
   * Swatch fields, carried so the editor can prefill them.
   *
   * An edit form that cannot show the current colour would silently blank it on
   * the first save — the field would post empty because it started empty.
   */
  colorHex?: string | null;
  imageUrl?: string | null;

  /**
   * How this value is priced, beyond a flat amount.
   *
   * 🔴 **The API has always sent it; this type dropped it.** The authoring
   * projection carries sixteen fields per value and this interface declared
   * nine — so `priceConfig` arrived on every editor load and was discarded at
   * the type boundary.
   *
   * ⚠️ **M20.6 cannot compute a sample total without it.** `optionPricingDelta`
   * takes it as its first argument and returns zero when it is absent, so an
   * evaluator copied without this would have priced every configured value at
   * **£0.00** and looked like it was working.
   *
   * 📌 `Record<string, unknown>` rather than a union, matching the projection:
   * the column is a JSON blob whose shape is fixed by `pricingConfigSchema` on
   * write, and the evaluator narrows it at read time.
   */
  priceConfig?: Record<string, unknown> | null;

  /**
   * What this choice does to fulfilment.
   *
   * 🔴 **Both reach the cart and neither could be set.** `sku_suffix` composes
   * the cart item's SKU (`CartItemData`) and `weight_delta_grams` changes the
   * shipping weight (`CartTotals::apply_weight`) — so a merchant selling an
   * engraved item could not make it ship heavier or carry its own SKU, though
   * the storefront would have honoured both.
   *
   * ⚠️ **The weight is SIGNED.** A lighter variant is a real thing — hollow
   * rather than solid, a smaller size — and `@IsInt()` accepts a negative.
   */
  skuSuffix?: string | null;
  weightDeltaGrams?: number | null;

  /**
   * Whether this value is chosen when the customer arrives.
   *
   * 📌 **At most one per option, and the SERVER enforces it.**
   * `clearOtherDefaults` runs on create and update, so the editor sets the flag
   * and does not replicate the rule — two implementations of "only one" is two
   * places for them to disagree.
   */
  isDefault?: boolean;

  /**
   * Whether this value is offered to customers.
   *
   * 🔴 **The reversible alternative to deleting**, and it was reachable only
   * for rules. The publish serializer filters disabled values out, so taking a
   * colour off sale for a fortnight is a flag — where a delete is a shape
   * change that clears the undo log, with no restore endpoint.
   *
   * 📌 **Absent from the published projection**, because a disabled value is
   * filtered before serialisation: the storefront never sees the flag, only its
   * effect.
   */
  isEnabled?: boolean;
}

/** A reason a set cannot publish, or should not silently. */
export interface PublishFinding {
  severity: 'blocker' | 'warning';
  code: string;
  /** `option:<id>` or `set:<id>` — so the UI points at the thing, not a list. */
  subject: string;
  message: string;
}

export interface PublishResult {
  version: number;
  publishedAt: string;
  configVersion: number;
  warnings: PublishFinding[];
}

export async function listSets(storeId?: string): Promise<OptionSetSummary[]> {
  const { data } = await api.get<OptionSetSummary[]>('/option-sets', {
    query: { storeId, limit: 100 },
  });

  return data;
}

/**
 * The whole tree in one call.
 *
 * `GET /:id/detail` nests set → groups → options → values and carries
 * `rowVersion`, so the editor loads once and writes with the version it
 * received. Fetching each level separately would be a waterfall *and* would
 * leave no single version to echo back.
 */
export async function loadSet(id: string): Promise<AuthoringSet> {
  const { data } = await api.get<AuthoringSet>(`/option-sets/${id}/detail`);

  return data;
}

/**
 * The set's current `rowVersion`, without its tree.
 *
 * 🔴 **`GET /:id` rather than `/:id/detail`** — the set head only, so refreshing
 * the optimistic-lock token after an edit costs a small request instead of the
 * whole authoring tree. At `AUTHORING_LIMITS` scale the tree is 600 options and
 * 12,000 values; the token is one integer.
 *
 * ⚠️ **Needed because a patched tree cannot carry it.** Every child edit
 * advances the parent set's version server-side (`ParentSetService`), and the
 * edit response returns only the entity that changed.
 */
export async function loadSetVersion(id: string): Promise<number> {
  const { data } = await api.get<OptionSetSummary>(`/option-sets/${id}`);

  return data.rowVersion;
}

export async function createSet(name: string, storeId: string): Promise<OptionSetSummary> {
  const { data } = await api.post<OptionSetSummary>('/option-sets', { name, storeId });

  return data;
}

/**
 * Rename, or change anything else on the set.
 *
 * 🔴 **`rowVersion` is required here even though the API marks it optional.**
 * `assertVersionMatches()` only throws when a version is *sent*, so omitting it
 * is silent last-write-wins — the failure the entity's own comment calls
 * "unforgivable in an authoring tool". Making it required in this signature is
 * what turns an opt-in protection into one the dashboard cannot skip.
 */
export async function updateSet(
  id: string,
  rowVersion: number,
  changes: { name?: string },
): Promise<OptionSetSummary> {
  const { data } = await api.patch<OptionSetSummary>(`/option-sets/${id}`, {
    ...changes,
    rowVersion,
  });

  return data;
}

/** Soft delete. The version travels as a query parameter here, not a body field. */
export async function deleteSet(id: string, rowVersion: number): Promise<void> {
  await api.delete(`/option-sets/${id}`, { query: { rowVersion } });
}

/**
 * Copy a set, optionally into a different store of the same tenant (M20.8).
 *
 * 🔴 **The multi-store differentiator [D5] promises.** Without `storeId` the
 * copy lands in the source's own store, which is the common case; with one, a
 * merchant running several storefronts stops rebuilding the same option set by
 * hand for each.
 *
 * ⚠️ **The target is verified server-side against the acting tenant**, and a
 * store belonging to someone else answers **404** — indistinguishable from one
 * that does not exist, so the error cannot be used to probe for real stores.
 *
 * 📌 **Assignments are not copied.** They name products by external id, which
 * means nothing in another store, so the copy arrives unassigned rather than
 * pointing at products that are not there.
 */
/**
 * Rebuild a set from an exported document (M20.8).
 *
 * 🔴 **One request, because the server builds it in one transaction.** Doing
 * this from here as a sequence of creates would leave a set nobody authored
 * when a document failed halfway — and a create is a shape change that clears
 * the undo log, so there would be no way back.
 *
 * ⚠️ **The document is validated twice, deliberately.** `parsePortable` refuses
 * a file before it is sent, so a merchant reads which line is wrong; the API
 * validates again against the registry, because a client check is a courtesy
 * and never the boundary.
 */
export async function importSet(
  storeId: string,
  document: Record<string, unknown>,
): Promise<OptionSetSummary> {
  const { data } = await api.post<OptionSetSummary>('/option-sets/import', {
    storeId,
    document,
  });

  return data;
}

export async function duplicateSet(
  id: string,
  name?: string,
  storeId?: string,
): Promise<OptionSetSummary> {
  const { data } = await api.post<OptionSetSummary>(`/option-sets/${id}/duplicate`, {
    name,
    storeId,
  });

  return data;
}

/**
 * Whether the storefront is serving something older than the editor shows.
 *
 * 🔴 **A merchant editing a published set had no sign of this.** Adding a value
 * leaves `status: published` and `configVersion` unchanged — correctly, because
 * snapshots are immutable and only a publish advances the revision — so the
 * dashboard showed the new value while the storefront still served the old one,
 * with nothing on screen saying so.
 *
 * ## Why neither timestamp nor version answers it
 *
 * Both were tried and both are wrong:
 *
 * - **`updatedAt > publishedAt`** looks right and is not: `@UpdateDateColumn`
 *   stores whole seconds here (measured — `updatedAt` comes back `.000` while
 *   `publishedAt` keeps milliseconds), so an edit in the same second as a
 *   publish compares as *older* and reads clean.
 * - **`rowVersion`** is exact, but **publishing bumps it too**
 *   (`publish.service.ts` sets `rowVersion + 1`) and nothing records which
 *   version was published — so there is no baseline to compare against.
 *
 * So the comparison is of content: `preview` is what a storefront *would*
 * receive, the latest snapshot is what it *has*. Two requests, and only for a
 * set that has been published at all.
 */
/**
 * What changed since the last publish, named rather than counted.
 *
 * 🔴 **`hasUnpublishedChanges` already fetched both documents** and reduced
 * them to a boolean — so a merchant publishing to a live storefront was told
 * *that* something differed and never *what*. This returns the same answer with
 * the comparison kept.
 *
 * 📌 **`canonical` is shared with the boolean**, so the two cannot disagree
 * about what "identical" means.
 */
export async function unpublishedChanges(id: string, version: number): Promise<string[]> {
  const [preview, snapshot] = await Promise.all([
    api.get<unknown>(`/option-sets/${id}/preview`),
    api.get<{ snapshot?: unknown }>(`/option-sets/${id}/versions/${version}`),
  ]);

  const published = (snapshot.data as { snapshot?: unknown }).snapshot ?? snapshot.data;

  return describeChanges(preview.data, published);
}

export async function hasUnpublishedChanges(id: string, version: number): Promise<boolean> {
  const [preview, snapshot] = await Promise.all([
    api.get<unknown>(`/option-sets/${id}/preview`),
    api.get<{ snapshot?: unknown }>(`/option-sets/${id}/versions/${version}`),
  ]);

  const published = (snapshot.data as { snapshot?: unknown }).snapshot ?? snapshot.data;

  /*
   * ⚠️ **Key order is NOT stable between these two**, so a plain
   * `JSON.stringify` comparison reports a difference for identical content.
   * Measured: `preview` returns `[id, version, assignments, groups, rules]`
   * while the stored snapshot returns `[id, rules, groups, version,
   * assignments]` — the snapshot was serialised at publish time and round-tripped
   * through a JSON column, which does not preserve insertion order.
   *
   * So both sides are canonicalised first. A structural comparison rather than a
   * field-by-field one, because any difference between what would ship and what
   * shipped is worth telling a merchant about, and enumerating fields would go
   * stale as the document grows.
   */
  return canonical(preview.data) !== canonical(published);
}

/**
 * A stable string for any JSON value, whatever order its keys arrive in.
 *
 * Arrays keep their order — in this document that is `sort_order`, and two
 * options swapping places is a real change a merchant should be told about.
 */

/** What would stop this publishing, asked before offering the button. */
export async function publishCheck(id: string): Promise<PublishFinding[]> {
  const { data } = await api.get<{ findings: PublishFinding[] }>(`/option-sets/${id}/publish-check`);

  return data.findings;
}

export async function publishSet(
  id: string,
  rowVersion: number,
  note?: string,
): Promise<PublishResult> {
  const { data } = await api.post<PublishResult>(`/option-sets/${id}/publish`, { rowVersion, note });

  return data;
}

// --- The authoring tree ----------------------------------------------------
//
// Groups, options and values carry **no** `rowVersion`: only the set has one, so
// a concurrent edit inside a set is last-write-wins by construction. Recorded
// here rather than papered over, so the editor does not imply a safety it lacks.

export async function createGroup(setId: string, label: string): Promise<AuthoringGroup> {
  const { data } = await api.post<AuthoringGroup>(`/option-sets/${setId}/groups`, { label });

  return data;
}

/**
 * Change a group's presentation.
 *
 * 🔴 **The half M18.4 had to build.** `displayType` and `isCollapsible` have
 * been stored, accepted by the API and published in the config document since
 * Phase 5 — and authorable nowhere, because the editor could only *create* a
 * group by label and delete it. ADR-059 requires both halves in one stage: a
 * field the storefront honours but no merchant can set is the same defect as
 * one nothing reads, in the other direction.
 *
 * ⚠️ **`stepped` is deliberately absent from what the picker offers** (ADR-063),
 * though the API accepts it. It renders as `inline` until its own stage, and a
 * fourth choice that silently behaves like the first is how a merchant
 * discovers a gap in production.
 */
export async function updateGroup(
  id: string,
  changes: {
    label?: string;
    displayType?: string;
    isCollapsible?: boolean;

    /** Whether the group is offered — the reversible alternative to deleting. */
    isEnabled?: boolean;

    /**
     * The group's own help text, shown above its options.
     *
     * 🔴 **Stored, published and RENDERED since Phase 5 — and settable
     * nowhere.** `createGroup` sends only a label, and there was no group edit
     * form at all, so the paragraph the storefront draws in both template
     * branches could never be filled in. The API has accepted it all along
     * (`@MaxLength(2000)`); only the client was missing.
     *
     * ⚠️ **M18.5 lists "help text" as new work.** It is not: this is it, and
     * M18.6a delivers it (ADR-064).
     */
    description?: string;
  },
): Promise<AuthoringGroup> {
  const { data } = await api.patch<AuthoringGroup>(`/groups/${id}`, changes);

  return data;
}

export async function deleteGroup(id: string): Promise<void> {
  await api.delete(`/groups/${id}`);
}

export async function createOption(
  groupId: string,
  input: {
    key: string;
    label: string;
    presentation: string;
    isRequired: boolean;
    /**
     * Per-type rules the API shape-checks against the registry — `maxLength`
     * for a text option (M14.4).
     *
     * ⚠️ **Declared rather than left to spread.** These reached the request
     * through `...configFor()` and type-checked anyway, because an object
     * literal spread into a call is not checked for excess properties. So a
     * typo in a key name would have been sent, accepted as `Record<string,
     * unknown>` by the DTO, and silently ignored — naming them here is what
     * makes that a compile error.
     */
    validation?: Record<string, unknown>;
    /** Display affordances — `characterCounter` (M14.4b). */
    display?: Record<string, unknown>;

    /**
     * Whether the option takes one answer or several (M18.3a).
     *
     * 🔴 **Omitting it is not neutral — it chooses `one`.**
     * `OptionsService.create()` falls back to `definition.cardinality[0]`, and
     * the registry lists `[ONE, MANY]` for a checkbox with `ONE` first, so a
     * request that leaves this out gets a single-value option every time.
     *
     * ⚠️ **And it cannot be corrected afterwards.** `cardinality` is absent
     * from `OptionChanges`, so it is immutable after creation by type. That is
     * why M18.1–M18.3 built a multi-select path no merchant could reach: the
     * storefront could resolve, price, freeze and display several answers, and
     * every option the dashboard created was `one`.
     */
    cardinality?: string;
  },
): Promise<AuthoringOption> {
  const { data } = await api.post<AuthoringOption>(`/groups/${groupId}/options`, input);

  return data;
}

export async function updateOption(
  id: string,
  changes: {
    label?: string;
    isRequired?: boolean;

    /**
     * The wording a customer reads beside this option.
     *
     * 🔴 **An empty string CLEARS**, and that is deliberate: a merchant
     * deleting help text is making a choice, and treating `''` as "no change"
     * would leave text on the storefront they had just removed.
     *
     * ⚠️ **`undefined` leaves the field alone**, which is how a choice option
     * skips `placeholder` — it has no box to put one in.
     */
    description?: string;
    placeholder?: string;
    helpText?: string;
    defaultValue?: string;

    /** Whether the option is offered — the reversible alternative to deleting. */
    isEnabled?: boolean;

    /**
     * The limits a customer's answer must satisfy.
     *
     * ⚠️ **`undefined` leaves it alone; `null` clears it.** A choice option
     * sends `undefined` — it has no bounds — and a merchant emptying both
     * bounds on a text option with no other rules sends `null`.
     *
     * 🔴 **Whatever the editor does not author is merged back in**, because the
     * per-type schemas are `.strict()`: sending a validation object without a
     * stored `pattern` would silently delete it.
     */
    validation?: Record<string, unknown> | null;

    /**
     * How this option is drawn.
     *
     * 🔴 **`characterCounter` is derived from `validation.maxLength`** at the
     * call site that sets both, never offered as a switch a merchant could set
     * against their own limit.
     */
    display?: Record<string, unknown> | null;

    /**
     * How this **option** is priced, for the types that price per option.
     *
     * 🔴 **`null` CLEARS it**, which is what lets a merchant stop charging for
     * an engraving without deleting the option.
     *
     * ⚠️ **The STORED shape — `amountMinor`, `freeCharacters`.** The API
     * validates against that option type's `pricingSchema`, written in the
     * stored dialect; the wire shape the plugin reads is the serializer's job.
     */
    pricing?: Record<string, unknown> | null;
  },
): Promise<AuthoringOption> {
  const { data } = await api.patch<AuthoringOption>(`/options/${id}`, changes);

  return data;
}

export async function deleteOption(id: string): Promise<void> {
  await api.delete(`/options/${id}`);
}

/**
 * Create a heading, paragraph or divider.
 *
 * `sortOrder` is omitted on purpose: the server appends after the highest
 * sibling in gap-tolerant steps, exactly as it does for options. Sending one
 * from here would mean the client guessing at an order it does not own.
 *
 * ⚠️ **A divider's content is `''`, not `undefined`.** The API requires the field
 * and allows it to be empty for that kind alone — sending nothing would fail
 * validation on a field the merchant never sees.
 */
export async function createItem(
  groupId: string,
  input: { kind: ItemKind; content: string; display?: Record<string, unknown> },
): Promise<AuthoringItem> {
  const { data } = await api.post<AuthoringItem>(`/groups/${groupId}/items`, input);

  return data;
}

export async function updateItem(
  id: string,
  changes: { content?: string; display?: Record<string, unknown> },
): Promise<AuthoringItem> {
  const { data } = await api.patch<AuthoringItem>(`/items/${id}`, changes);

  return data;
}

export async function deleteItem(id: string): Promise<void> {
  await api.delete(`/items/${id}`);
}

export async function createValue(
  optionId: string,
  input: {
    valueKey: string;
    label: string;
    priceAmountMinor?: number;
    /**
     * What makes a swatch a swatch.
     *
     * 🔴 **Absent until now, which is why `color_swatch` and `image_swatch` were
     * registered in the API and not authorable here.** A merchant could pick
     * "colour swatch", fill in three values, publish — and get plain radios,
     * because the storefront template drops a chip it has no colour for.
     *
     * Both are optional and omitted for the choice types that do not use them:
     * sending `colorHex: undefined` on a radio value is not an error, it is
     * simply a value with no colour.
     */
    colorHex?: string;
    imageUrl?: string;
    /**
     * The `<optgroup>` heading (M14.3).
     *
     * Sent for `dropdown` only, and never as an empty string: the API's
     * `@IsOptional` skips an absent field, and a blank heading would render as
     * an unlabelled indent rather than as "not grouped".
     */
    groupLabel?: string;
  },
): Promise<AuthoringValue> {
  const { data } = await api.post<AuthoringValue>(`/options/${optionId}/values`, {
    ...input,
    // `fixed` is the only price type this editor authors; the API defaults to it
    // too, and stating it keeps the stored row explicit rather than implied.
    priceType: 'fixed',
  });

  return data;
}

/**
 * Edit a value in place.
 *
 * 🔴 **Absent until now, which made every value write-once.** `PATCH /values/:id`
 * has existed since Phase 7; the dashboard never called it, so correcting a
 * mistyped label, price, colour or group heading meant deleting the value and
 * recreating it — losing its id, its ordering, and any rule that pointed at it.
 *
 * ⚠️ **`valueKey` is deliberately not editable.** It is the identifier a published
 * document, a cart line and an order line all carry; changing it would orphan
 * every order already placed with the old key. Renaming is a delete plus a
 * create, which is what it actually is.
 *
 * `null` clears an optional field — the API's `@IsOptional` skips an absent one,
 * so omitting a key leaves it unchanged.
 */
export async function updateValue(
  id: string,
  changes: {
    label?: string;
    priceAmountMinor?: number;

    /**
     * How this value is priced, beyond a flat amount (M20.6 audit F1).
     *
     * 🔴 **`null` CLEARS it**, which is what makes switching back to a flat
     * amount honest: leaving a stored percentage behind would have the
     * storefront charging it while the editor showed the flat figure.
     *
     * ⚠️ **The STORED shape — `basisPoints`, camelCase.** `pricingConfigSchema`
     * validates this dialect; converting to the wire shape the plugin reads is
     * the serializer's job, not a caller's.
     */
    priceConfig?: Record<string, unknown> | null;

    /**
     * What this choice does to fulfilment.
     *
     * ⚠️ **`null` clears; `undefined` leaves unchanged**, like the swatch
     * fields beside them — a value type that does not use one is left alone
     * rather than blanked.
     */
    skuSuffix?: string | null;
    weightDeltaGrams?: number | null;

    /** The server clears any other default on the same option. */
    isDefault?: boolean;

    /** Whether the value is offered — the reversible alternative to deleting. */
    isEnabled?: boolean;

    colorHex?: string | null;
    imageUrl?: string | null;
    groupLabel?: string | null;
  },
): Promise<AuthoringValue> {
  const { data } = await api.patch<AuthoringValue>(`/values/${id}`, changes);

  return data;
}

export async function deleteValue(id: string): Promise<void> {
  await api.delete(`/values/${id}`);
}

/**
 * Reorder the groups within a set.
 *
 * 🔴 **The endpoint was fully built and the dashboard never called it.** A
 * merchant could reorder options *within* a group from the first release and
 * could not move the groups themselves at all — so on a product with three
 * sections, their order was whatever order they happened to be created in,
 * permanently. Found by auditing Phase 18, and the same shape as M18.3a's F1:
 * a server capability with no client.
 *
 * ⚠️ **Its own endpoint, and a different one from the options reorder.**
 * `POST /groups/:id/reorder` moves options *inside* one group;
 * `POST /option-sets/:id/reorder` moves the groups. Sending a group id to the
 * first is rejected as `NOT_IN_GROUP` and an option id to this one as
 * `NOT_IN_SET`, which is what makes them safe to confuse at compile time and
 * never at runtime.
 *
 * The server applies the whole list in one transaction and refuses any id that
 * does not belong to the set, so a half-applied order is not reachable.
 */
export async function reorderGroups(setId: string, entries: SortEntry[]): Promise<void> {
  await api.post(`/option-sets/${setId}/reorder`, { groups: entries });
}

/**
 * Reorder siblings in one write, at any level.
 *
 * ⚠️ **Takes explicit `sortOrder`s rather than deriving them from array index.**
 * When a group holds options *and* presentational items they share one scale, and
 * a position within this list alone cannot express where an option sits relative
 * to a heading. Numbering by index here made cross-kind moves no-ops that still
 * answered `201` — see `reorderPayloads`.
 */
export async function reorderOptions(groupId: string, entries: SortEntry[]): Promise<void> {
  await api.post(`/groups/${groupId}/reorder`, { options: entries });
}

/**
 * Reorder a group's presentational items.
 *
 * 🔴 **A separate endpoint, and it must stay separate.** Options and items live
 * in different tables; `POST /groups/:id/reorder` would reject an item's id as
 * `NOT_IN_GROUP`, and this one rejects an option's. They share only the
 * `sortOrder` scale, which is what lets the storefront interleave them.
 *
 * ⚠️ **So moving an item past an option takes two writes.** `moveEntry` in the
 * editor sends whichever list actually changed; a single-call reorder across
 * both would need an endpoint that spans the two tables, which is a server
 * change rather than a client one.
 */
export async function reorderItems(groupId: string, entries: SortEntry[]): Promise<void> {
  await api.post(`/groups/${groupId}/items/reorder`, { items: entries });
}

/**
 * One product an option set applies to (M13.6).
 *
 * `productName` and `productStatus` are joined server-side from `store_products`
 * via a LEFT JOIN, so an assignment survives its product disappearing — the row
 * is still listed, with a `null` name. That null is the signal the picker needs:
 * the option has quietly stopped rendering while the list still says it applies.
 *
 * ⚠️ `targetRef` is **WooCommerce's** product id, not our `Product.id`.
 */
export interface AssignmentView {
  id: string;
  mode: string;
  targetType: string | null;
  targetRef: string | null;
  priority: number;
  productName: string | null;
  productStatus: string | null;
}

/**
 * What both assignment writes return.
 *
 * Not a bare list: every write advances the store's config revision, and
 * `configVersion` is the revision a storefront must reach before the change is
 * visible there. Discarding it would leave the dashboard unable to say whether
 * a merchant is looking at stale output.
 */
export interface AssignmentWriteResult {
  assignments: AssignmentView[];
  configVersion: number;
}

export async function listAssignments(setId: string): Promise<AssignmentView[]> {
  const { data } = await api.get<AssignmentView[]>(`/option-sets/${setId}/assignments`);

  return data;
}

/**
 * The target types a merchant can assign to (M19.1').
 *
 * 🔴 **Mirrors `ASSIGNABLE_TARGET_TYPES` on the server**, which is the
 * authority — the API validates against its own list and a value missing there
 * is a 400, not a silent skip. Kept in the same order so the two read alike.
 */
export const ASSIGNMENT_TARGET_TYPES = [
  'product',
  'category',
  'tag',
  'attribute',
  'price_range',
] as const;

export type AssignmentTargetType = (typeof ASSIGNMENT_TARGET_TYPES)[number];

/** What a merchant is shown for each target type, and what they type into it. */
export const TARGET_TYPE_LABELS: Record<AssignmentTargetType, string> = {
  product: 'Product',
  category: 'Category',
  tag: 'Tag',
  attribute: 'Attribute',
  price_range: 'Price range',
};

/** One thing a set is assigned to: the reference means nothing without its type. */
export interface AssignmentTarget {
  targetType: AssignmentTargetType;
  targetRef: string;
}

/** Idempotent: re-assigning an already-assigned product is a no-op, not a 409. */
export async function assignProducts(
  setId: string,
  externalProductIds: string[],
): Promise<AssignmentWriteResult> {
  return assignTargets(
    setId,
    externalProductIds.map((targetRef) => ({ targetType: 'product', targetRef })),
  );
}

/**
 * Assign a set to any target type (M19.1').
 *
 * ⚠️ **`assignProducts` now routes through here.** Two functions posting two
 * different body shapes to one endpoint is how the shapes drift; the product
 * helper stays because the picker's catalogue list reads better for it, but it
 * is a convenience over this, not a parallel path.
 */
export async function assignTargets(
  setId: string,
  targets: AssignmentTarget[],
): Promise<AssignmentWriteResult> {
  const { data } = await api.post<AssignmentWriteResult>(
    `/option-sets/${setId}/assignments`,
    { targets },
  );

  return data;
}

/** The path segment is a WooCommerce id, so it must be encoded, not assumed UUID-safe. */
export async function unassignProduct(
  setId: string,
  externalProductId: string,
): Promise<AssignmentWriteResult> {
  return unassignTarget(setId, { targetType: 'product', targetRef: externalProductId });
}

/**
 * Unassign any target type (M19.1').
 *
 * 🔴 **The type travels as a query parameter, and it is not optional here even
 * though the API defaults it.** `targetRef` is unique only *within* a type, so
 * omitting it would remove the product row whenever a category shares a
 * reference with one — an ordinary collision, not an exotic one.
 */
export async function unassignTarget(
  setId: string,
  target: AssignmentTarget,
): Promise<AssignmentWriteResult> {
  const { data } = await api.delete<AssignmentWriteResult>(
    `/option-sets/${setId}/assignments/${encodeURIComponent(target.targetRef)}` +
      `?targetType=${encodeURIComponent(target.targetType)}`,
  );

  return data;
}

/** What a bulk removal reports back (M19.5). */
export interface BulkUnassignResult extends AssignmentWriteResult {
  /**
   * How many live rows were actually removed.
   *
   * Fewer than asked for when the selection had gone stale — which the API
   * treats as success, so this count is the only way to tell.
   */
  removed: number;
}

/**
 * Unassign many targets in one request (M19.5).
 *
 * 🔴 **`POST .../unassign`, not `DELETE` with a body.** A body on DELETE is
 * undefined by RFC 9110 and dropped by some proxies and fetch stacks, so a bulk
 * removal that removed nothing would be indistinguishable from one that worked.
 * The single-target `DELETE /:targetRef` above is untouched.
 */
export async function unassignTargets(
  setId: string,
  targets: AssignmentTarget[],
): Promise<BulkUnassignResult> {
  const { data } = await api.post<BulkUnassignResult>(
    `/option-sets/${setId}/assignments/unassign`,
    { targets },
  );

  return data;
}

/** What a target would apply to, before applying it (M19.5). */
export interface TargetPreview {
  /**
   * Mirrored products the target matches today, or `null` when the type has no
   * countable meaning (`attribute`, `price_range`).
   */
  matched: number | null;
  /**
   * Whether the count is exact.
   *
   * ⚠️ A taxonomy count is an **estimate**: the mirror is a snapshot and the
   * storefront resolves `has_term()` live, so a product categorised afterwards
   * still matches. Presenting an inexact count as a promise is the thing this
   * flag exists to prevent.
   */
  exact: boolean;
}

/** How many products a target would apply to, before applying it (M19.5). */
export async function previewTarget(
  setId: string,
  target: AssignmentTarget,
): Promise<TargetPreview> {
  const { data } = await api.get<TargetPreview>(
    `/option-sets/${setId}/assignments/preview` +
      `?targetType=${encodeURIComponent(target.targetType)}` +
      `&targetRef=${encodeURIComponent(target.targetRef)}`,
  );

  return data;
}

/** One published version, as the history lists it (M20.9). */
export interface VersionSummary {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  note: string | null;
}

/**
 * Every version this set has published, newest first.
 *
 * 🔴 **The backend has answered this since Phase 7; nothing asked.** The
 * endpoint, the rollback it feeds and the snapshot reader were all built and
 * tested server-side, and the dashboard called **one** of the three — inside
 * `hasUnpublishedChanges`, to compare against the current draft. So a merchant
 * could be told their work was unpublished and had no way to see what *was*
 * published, or to go back to it.
 */
export async function listVersions(id: string): Promise<VersionSummary[]> {
  const { data } = await api.get<{ versions: VersionSummary[] }>(
    `/option-sets/${id}/versions`,
  );

  return data.versions;
}

/**
 * Republish an earlier version (M20.9).
 *
 * ⚠️ **A rollback publishes a NEW version; it never rewrites history.** The
 * DTO's own wording — *"published as a new version, never rewritten"* — and it
 * matters for the audit trail: a storefront that received version 4 can still
 * be explained after a merchant rolls back to 2, because the restore is
 * version 5.
 *
 * 📌 **`rowVersion` is the optimistic-concurrency check.** Two people looking
 * at the same history, both choosing a version, must not have the second
 * silently win — the API refuses a stale one rather than applying it.
 */
export async function rollbackTo(
  id: string,
  version: number,
  rowVersion: number,
  note?: string,
): Promise<void> {
  await api.post(`/option-sets/${id}/rollback`, { version, rowVersion, note });
}

/* -------------------------------------------------------------------------
 * Conditional rules (M17.6)
 * ---------------------------------------------------------------------- */

/**
 * One condition, as the API stores and returns it.
 *
 * ⚠️ **`value` is absent for the unary operators**, not null. The schema is
 * `.strict()`, so sending `value: null` with `is_empty` is a 400 rather than an
 * ignored field — `UNARY_OPERATORS` in `@/lib/rules/vocabulary` is the list to
 * branch on.
 */
export interface RuleCondition {
  optionId: string;
  operator: RuleOperator;
  value?: string | number | boolean | Array<string | number | boolean>;
}

/** A rule as the authoring API returns it. */
export interface AuthoringRule {
  id: string;
  targetType: RuleTargetType;
  targetId: string;
  action: RuleAction;
  matchType: RuleMatchType;
  conditions: RuleCondition[];
  actionValue: Record<string, unknown> | null;
  sortOrder: number;
  isEnabled: boolean;
  /** Why the *system* switched it off, or null when the merchant did. */
  disabledReason: string | null;
}

/** What a new rule needs. The API fills in the rest. */
export interface NewRule {
  targetType: RuleTargetType;
  targetId: string;
  action: RuleAction;
  matchType: RuleMatchType;
  conditions: RuleCondition[];
  actionValue?: Record<string, unknown>;
}

export async function listRules(setId: string): Promise<AuthoringRule[]> {
  const { data } = await api.get<AuthoringRule[]>(`/option-sets/${setId}/rules`);

  return data;
}

export async function createRule(setId: string, rule: NewRule): Promise<AuthoringRule> {
  const { data } = await api.post<AuthoringRule>(`/option-sets/${setId}/rules`, rule);

  return data;
}

export async function updateRule(
  id: string,
  changes: Partial<NewRule> & { isEnabled?: boolean },
): Promise<AuthoringRule> {
  const { data } = await api.patch<AuthoringRule>(`/rules/${id}`, changes);

  return data;
}

export async function deleteRule(id: string): Promise<void> {
  await api.delete(`/rules/${id}`);
}

/**
 * What a customer would see, given these answers (ADR-053).
 *
 * 🔴 **The server evaluates, not this.** Three implementations of the rule
 * engine already exist — PHP for the storefront, TypeScript for publishing, and
 * JavaScript in the browser because AC3 forbids the storefront asking a server.
 * The dashboard has no such constraint, so a fourth would be spent for nothing:
 * a merchant testing a rule wants the storefront's answer, and the honest way to
 * get it is to ask the thing that decides.
 *
 * ⚠️ **It reads the merchant's draft**, so a rule authored and not yet published
 * is included — which is the whole point of a tester.
 */
export interface RuleTestResult {
  hiddenOptionIds: string[];
  hiddenGroupIds: string[];
  hiddenValueIds: string[];
  requiredOptionIds: string[];
  optionalOptionIds: string[];
  passes: number;
  /** Set when the rules did not settle; the lists are then empty (ADR-050). */
  refused: string | null;
}

export async function testRules(
  setId: string,
  answers: Record<string, unknown>,
): Promise<RuleTestResult> {
  const { data } = await api.post<RuleTestResult>(`/option-sets/${setId}/rules/test`, { answers });

  return data;
}
