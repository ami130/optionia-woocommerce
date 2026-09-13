import { api } from '@/lib/api/client';
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
}

export interface AuthoringOption {
  id: string;
  key: string;
  label: string;
  presentation: string;
  isRequired: boolean;
  sortOrder: number;
  isEnabled: boolean;
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

export async function duplicateSet(id: string, name?: string): Promise<OptionSetSummary> {
  const { data } = await api.post<OptionSetSummary>(`/option-sets/${id}/duplicate`, { name });

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
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

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
export async function updateGroupDisplay(
  id: string,
  changes: { displayType?: string; isCollapsible?: boolean },
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
  changes: { label?: string; isRequired?: boolean },
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
  input: { kind: ItemKind; content: string },
): Promise<AuthoringItem> {
  const { data } = await api.post<AuthoringItem>(`/groups/${groupId}/items`, input);

  return data;
}

export async function updateItem(id: string, changes: { content: string }): Promise<AuthoringItem> {
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

/** Idempotent: re-assigning an already-assigned product is a no-op, not a 409. */
export async function assignProducts(
  setId: string,
  externalProductIds: string[],
): Promise<AssignmentWriteResult> {
  const { data } = await api.post<AssignmentWriteResult>(
    `/option-sets/${setId}/assignments`,
    { externalProductIds },
  );

  return data;
}

/** The path segment is a WooCommerce id, so it must be encoded, not assumed UUID-safe. */
export async function unassignProduct(
  setId: string,
  externalProductId: string,
): Promise<AssignmentWriteResult> {
  const { data } = await api.delete<AssignmentWriteResult>(
    `/option-sets/${setId}/assignments/${encodeURIComponent(externalProductId)}`,
  );

  return data;
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
