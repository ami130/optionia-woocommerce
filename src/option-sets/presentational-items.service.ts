import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DomainException } from '../common/errors/domain.exception';
import { OptionGroupsRepository } from './option-groups.repository';
import { ParentSetService } from './parent-set';
import { PresentationalItem } from './entities/presentational-item.entity';
import { PresentationalItemsRepository } from './presentational-items.repository';
import { PresentationalKind } from '../common/database/enums';
import { displaySchemaFor } from './types/presentational-display';
import { diff } from '../audit/audit-diff';
import { pick } from './entity-patch';

/** What a caller may set when creating an item. */
export interface CreateItemInput {
  kind: PresentationalKind;
  content: string;
  sortOrder?: number;
  display?: Record<string, unknown> | null;
}

/** What a caller may change. Kind is absent deliberately — see `update`. */
export interface ItemChanges {
  content?: string;
  sortOrder?: number;
  display?: Record<string, unknown> | null;
}

/**
 * Headings, paragraphs and dividers.
 *
 * 🔴 **The inlet this feature never had.** `presentational_items` has had a
 * table since Phase 5, with an entity, cascade handling, hard-delete handling
 * and both serialization paths — and no route could create one. Phase 14's own
 * Stage 0 named it (W2): data flowed end to end through a pipe with no inlet,
 * which is the most expensive shape a half-built feature can take, because it
 * looks finished from the schema and does nothing.
 *
 * ⚠️ **No validation, no pricing, no cart data** (M5.4c). An item participates in
 * exactly two systems — ordering and, once Phase 17 adds an `item` member to
 * `RuleTargetType`, conditional visibility — so
 * this service is deliberately thinner than `OptionsService`: there is no type
 * registry to consult and no axes to reconcile, because an item asks the
 * customer nothing. The pricing engine never sees one.
 *
 * ⚠️ **`rich_text` is not accepted here.** M5.4c gates it behind a sanitizer at
 * publish *and* at render, because it is merchant-authored markup on a public
 * storefront. The enum carries the value so the column and serializer are ready;
 * the DTO refuses it until that sanitizer exists. Shipping the inlet without the
 * gate would be the same mistake in the opposite direction.
 */
@Injectable()
export class PresentationalItemsService {
  constructor(
    private readonly items: PresentationalItemsRepository,
    private readonly groups: OptionGroupsRepository,
    private readonly parents: ParentSetService,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async listByGroup(optionGroupId: string): Promise<PresentationalItem[]> {
    await this.assertGroupExists(optionGroupId);

    return this.items.listByGroup(optionGroupId);
  }

  async findOne(id: string): Promise<PresentationalItem> {
    const item = await this.items.findById(id);

    if (!item) {
      throw DomainException.notFound('Presentational item');
    }

    return item;
  }

  /**
   * A validated `display` block, or `null` (M21c.5, F31, ADR-113).
   *
   * 🔴 **This was `input.display ?? null` — any JSON, stored and published.**
   * An option's `display` has been schema-checked per type since M14.4b; a
   * presentational item's was guarded by `@IsObject()` alone, so a payload
   * carrying `accent_color: '#fff; background: url(//evil)'` and a `<script>`
   * tag validated with **zero errors** and reached the wire intact. Inert only
   * because no template read it, and M21c.5 is what starts reading it.
   *
   * ⚠️ **A bad block is a refusal, not a silent drop.** `DomainException` is
   * how every other authoring rule answers, and storing `null` instead would
   * leave a merchant looking at a setting that vanished without explanation.
   */
  private displayFor(
    kind: PresentationalKind,
    display: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (display === null || display === undefined) {
      return null;
    }

    const parsed = displaySchemaFor(kind).safeParse(display);

    if (!parsed.success) {
      /*
       * The same shape an option's display failure produces: a dotted field
       * path per issue, so a dashboard showing one can show both identically.
       */
      throw DomainException.validation(
        parsed.error.issues.map((issue) => ({
          field: ['display', ...issue.path.map(String)].join('.'),
          code: 'invalid',
          params: { message: issue.message },
        })),
      );
    }

    return parsed.data as Record<string, unknown>;
  }

  async create(optionGroupId: string, input: CreateItemInput): Promise<PresentationalItem> {
    await this.assertGroupExists(optionGroupId);

    const siblings = await this.items.listByGroup(optionGroupId);

    assertWithinLimit(siblings.length, AUTHORING_LIMITS.itemsPerGroup, 'presentational items');

    const content = this.contentFor(input.kind, input.content);

    const created = await this.items.create(optionGroupId, {
      optionGroupId,
      kind: input.kind,
      content,
      sortOrder: input.sortOrder ?? (await this.items.nextSortOrder(optionGroupId)),
      display: this.displayFor(input.kind, input.display),
    } as never);

    await this.parents.touchForOption(optionGroupId);
    await this.audit.record({
      action: AuditAction.PRESENTATIONAL_ITEM_CREATED,
      resourceType: 'presentational_item',
      resourceId: created.id,
      changes: diff(null, { kind: created.kind, content: created.content }),
    });

    return created;
  }

  /**
   * Change an item's content, order or display.
   *
   * **`kind` is immutable.** Turning a heading into a divider discards its text
   * with no way back, and turning a divider into a heading produces one with no
   * text — both are better expressed as deleting one item and creating another,
   * which leaves an honest audit trail of what actually happened.
   */
  async update(id: string, changes: ItemChanges): Promise<PresentationalItem> {
    const before = await this.findOne(id);

    const patch: Partial<PresentationalItem> = {};

    if (changes.content !== undefined) {
      patch.content = this.contentFor(before.kind, changes.content);
    }

    if (changes.sortOrder !== undefined) {
      patch.sortOrder = changes.sortOrder;
    }

    if (changes.display !== undefined) {
      patch.display = this.displayFor(before.kind, changes.display);
    }

    if (Object.keys(patch).length === 0) {
      return before;
    }

    await this.items.update({ id } as never, patch as never);
    await this.parents.touchForOption(before.optionGroupId);

    await this.audit.record({
      action: AuditAction.PRESENTATIONAL_ITEM_UPDATED,
      resourceType: 'presentational_item',
      resourceId: id,
      changes: diff(pick(before, Object.keys(patch)), patch as Record<string, unknown>),
    });

    return this.findOne(id);
  }

  /**
   * Soft-delete an item.
   *
   * No cascade call: an item is a leaf with no children, and `RuleTargetType`
   * has no `item` member, so nothing can be pointing at it. If items ever become
   * rule targets, this is the method that has to start asking `CascadeService`.
   */
  async remove(id: string): Promise<void> {
    const before = await this.findOne(id);

    await this.items.update({ id } as never, { deletedAt: new Date() } as never);
    await this.parents.touchForOption(before.optionGroupId);

    await this.audit.record({
      action: AuditAction.PRESENTATIONAL_ITEM_DELETED,
      resourceType: 'presentational_item',
      resourceId: id,
      changes: diff({ kind: before.kind, deleted: false }, { kind: before.kind, deleted: true }),
    });
  }

  async reorder(
    optionGroupId: string,
    entries: ReadonlyArray<{ id: string; sortOrder: number }>,
  ): Promise<PresentationalItem[]> {
    await this.assertGroupExists(optionGroupId);

    const siblings = await this.items.listByGroup(optionGroupId);
    const known = new Set(siblings.map((item) => item.id));
    const unknown = entries.filter((entry) => !known.has(entry.id));

    if (unknown.length > 0) {
      throw DomainException.validation(
        unknown.map((entry, index) => ({
          field: `items.${index}.id`,
          code: 'NOT_IN_GROUP',
          params: { message: `Presentational item ${entry.id} does not belong to this group.` },
        })),
      );
    }

    await this.dataSource.transaction(async (manager) => {
      for (const entry of entries) {
        await manager.update(PresentationalItem, { id: entry.id }, { sortOrder: entry.sortOrder });
      }
    });

    await this.parents.touchForOption(optionGroupId);
    await this.audit.record({
      action: AuditAction.PRESENTATIONAL_ITEM_REORDERED,
      resourceType: 'option_group',
      resourceId: optionGroupId,
      changes: {
        items: {
          from: siblings.map((item) => ({ id: item.id, sortOrder: item.sortOrder })),
          to: entries.map((entry) => ({ id: entry.id, sortOrder: entry.sortOrder })),
        },
      },
    });

    return this.items.listByGroup(optionGroupId);
  }

  /**
   * Trim, and refuse emptiness — except for a divider.
   *
   * A divider carries no content, and requiring one would make a merchant type
   * something meaningless to draw a line. Every other kind does: a heading with
   * no text renders as nothing, which looks to the merchant like the item was
   * never saved.
   */
  private contentFor(kind: PresentationalKind, raw: string): string {
    const content = raw.trim();

    if (content === '' && kind !== PresentationalKind.DIVIDER) {
      throw DomainException.validation([
        {
          field: 'content',
          code: 'REQUIRED',
          params: { message: `A ${kind} with no content would render as nothing.` },
        },
      ]);
    }

    return content;
  }

  private async assertGroupExists(optionGroupId: string): Promise<void> {
    if (!(await this.groups.findById(optionGroupId))) {
      throw DomainException.notFound('Option group');
    }
  }
}
