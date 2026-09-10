import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AUTHORING_LIMITS, assertWithinLimit } from './authoring-limits';
import {
  AUTHORABLE_ITEM_KINDS,
  CreatePresentationalItemDto,
  ReorderPresentationalItemsDto,
} from './dto/presentational-item.dto';
import { PresentationalKind } from '../common/database/enums';
import { PresentationalItemsService } from './presentational-items.service';

/** Run the DTO through the same validator the request pipeline uses. */
function validate(body: Record<string, unknown>) {
  return validateSync(plainToInstance(CreatePresentationalItemDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CreatePresentationalItemDto', () => {
  it.each(['heading', 'paragraph', 'divider'])('accepts %s', (kind) => {
    expect(validate({ kind, content: 'x' })).toHaveLength(0);
  });

  /**
   * 🔴 **The sanitizer gate.**
   *
   * `rich_text` is merchant-authored markup rendered on a public storefront, and
   * M5.4c requires a strict allowlist sanitizer at publish *and* at render before
   * one can exist. The enum and the column carry the value so storage and
   * serialization are ready; this is what stops a row being created before the
   * gate does.
   *
   * If this test is ever changed to expect acceptance, the sanitizer must land in
   * the same commit — and `RendererTest::test_rich_text_renders_nothing_without_
   * its_sanitizer` on the plugin side has to change with it.
   */
  it('refuses rich_text while no sanitizer exists', () => {
    const errors = validate({ kind: 'rich_text', content: '<script>alert(1)</script>' });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('kind');
  });

  it('refuses an unknown kind', () => {
    expect(validate({ kind: 'marquee', content: 'x' })).toHaveLength(1);
  });

  it('refuses content beyond the cap', () => {
    expect(validate({ kind: 'paragraph', content: 'x'.repeat(5001) })).toHaveLength(1);
  });

  it('accepts content at exactly the cap', () => {
    expect(validate({ kind: 'paragraph', content: 'x'.repeat(5000) })).toHaveLength(0);
  });

  /** The gate is a deliberate subset of the enum, not a copy of it. */
  it('does not list every kind the enum defines', () => {
    expect(AUTHORABLE_ITEM_KINDS).not.toContain(PresentationalKind.RICH_TEXT);
    expect(AUTHORABLE_ITEM_KINDS).toHaveLength(3);
  });
});

describe('PresentationalItemsService content rules', () => {
  /** Only `contentFor` is under test, so the collaborators are never reached. */
  const service = new PresentationalItemsService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  const contentFor = (kind: PresentationalKind, raw: string): string =>
    (service as unknown as { contentFor(k: PresentationalKind, r: string): string }).contentFor(
      kind,
      raw,
    );

  it('trims surrounding whitespace', () => {
    expect(contentFor(PresentationalKind.HEADING, '   Personalise   ')).toBe('Personalise');
  });

  /**
   * A divider carries no content, and requiring one would make a merchant type
   * something meaningless to draw a line.
   */
  it('allows a divider to be empty', () => {
    expect(contentFor(PresentationalKind.DIVIDER, '')).toBe('');
    expect(contentFor(PresentationalKind.DIVIDER, '   ')).toBe('');
  });

  /**
   * A heading with no text renders as nothing, which looks to the merchant like
   * the item was never saved. Refusing it is the honest failure.
   */
  it.each([PresentationalKind.HEADING, PresentationalKind.PARAGRAPH])(
    'refuses a blank %s',
    (kind) => {
      expect(() => contentFor(kind, '   ')).toThrow();
    },
  );

  /** Whitespace-only is refused, but content that merely contains spaces is not. */
  it('keeps interior whitespace', () => {
    expect(contentFor(PresentationalKind.PARAGRAPH, '  a  b  ')).toBe('a  b');
  });
});

describe('itemsPerGroup', () => {
  /**
   * 🔴 **The limit was enforced and untested.**
   *
   * `assertWithinLimit` fires in `create`, and nothing checked that it does —
   * so removing the call would have passed the whole suite. The same was true of
   * `optionsPerGroup` and `valuesPerOption`; this covers the one this stage
   * added.
   */
  it('refuses a group that is already full', () => {
    expect(() =>
      assertWithinLimit(AUTHORING_LIMITS.itemsPerGroup, AUTHORING_LIMITS.itemsPerGroup, 'items'),
    ).toThrow();
  });

  it('allows the last item that fits', () => {
    expect(() =>
      assertWithinLimit(AUTHORING_LIMITS.itemsPerGroup - 1, AUTHORING_LIMITS.itemsPerGroup, 'items'),
    ).not.toThrow();
  });

  /**
   * ⚠️ Deliberately lower than `optionsPerGroup`: items exist to make a long
   * form readable, and a group needing fifty headings is several groups.
   */
  it('is lower than the option ceiling', () => {
    expect(AUTHORING_LIMITS.itemsPerGroup).toBeLessThan(AUTHORING_LIMITS.optionsPerGroup);
  });

  /**
   * The reorder cap reads the constant rather than repeating it.
   *
   * A request can never legitimately reorder more items than a group may hold,
   * and two literals drift the moment one is raised.
   */
  it('bounds the reorder payload at the same number', () => {
    const tooMany = Array.from({ length: AUTHORING_LIMITS.itemsPerGroup + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      sortOrder: i * 10,
    }));

    const errors = validateSync(plainToInstance(ReorderPresentationalItemsDto, { items: tooMany }));

    expect(errors).toHaveLength(1);
  });

  it('accepts a full-size reorder payload', () => {
    const exact = Array.from({ length: AUTHORING_LIMITS.itemsPerGroup }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      sortOrder: i * 10,
    }));

    const errors = validateSync(plainToInstance(ReorderPresentationalItemsDto, { items: exact }));

    expect(errors).toHaveLength(0);
  });
});
