import { PresentationalKind } from '../../common/database/enums';
import { DIVIDER_STYLES, displaySchemaFor } from './presentational-display';

/**
 * 🔴 **The boundary that did not exist** (F31, M21c.5).
 *
 * A presentational item's `display` was guarded by `@IsObject()` alone, so any
 * JSON was accepted, stored and published to the plugin verbatim. Measured
 * before this schema: the hostile payload below validated with **zero errors**.
 */
describe('presentational display schema', () => {
  const divider = () => displaySchemaFor(PresentationalKind.DIVIDER);

  it('accepts the three divider styles and nothing else', () => {
    for (const style of DIVIDER_STYLES) {
      expect(divider().safeParse({ style }).success).toBe(true);
    }

    expect(DIVIDER_STYLES).toEqual(['solid', 'dashed', 'dotted']);
  });

  /**
   * ⚠️ **The styles ADR-113 declined.** `optionia-app` ships these; three of
   * them have no CSS equivalent and are synthesized. Refusing them here is what
   * keeps the decision a decision rather than a comment.
   */
  it.each(['double', 'groove', 'ridge', 'inset', 'outset', 'wave', 'triple'])(
    'refuses the out-of-scope style %s',
    (style) => {
      expect(divider().safeParse({ style }).success).toBe(false);
    },
  );

  /**
   * 🔴 **The payload that used to pass.** Verbatim from the probe that found
   * F31: a CSS-injection string, a script tag, and unbounded nesting.
   */
  it('refuses the payload that previously validated with zero errors', () => {
    const hostile = {
      accent_color: '#fff; background: url(//evil)',
      anything_at_all: '<script>alert(1)</script>',
      nested: { deep: { deeper: 'unbounded' } },
    };

    expect(divider().safeParse(hostile).success).toBe(false);
  });

  /**
   * `.strict()` is what turns this from documentation into a boundary: an
   * unknown key is a refusal, not a silent store.
   */
  it('refuses an unknown key beside a valid one', () => {
    expect(divider().safeParse({ style: 'solid', colour: '#f00' }).success).toBe(false);
  });

  it('accepts an empty block', () => {
    expect(divider().safeParse({}).success).toBe(true);
  });

  /**
   * 📌 **Headings and paragraphs carry no display configuration** (ADR-113).
   * Empty and strict is the honest spelling — it accepts `{}` and refuses
   * everything else, where no schema at all would accept anything.
   */
  it.each([PresentationalKind.HEADING, PresentationalKind.PARAGRAPH])(
    '%s accepts an empty block and refuses every key',
    (kind) => {
      expect(displaySchemaFor(kind).safeParse({}).success).toBe(true);
      expect(displaySchemaFor(kind).safeParse({ style: 'solid' }).success).toBe(false);
      expect(displaySchemaFor(kind).safeParse({ anything: 1 }).success).toBe(false);
    },
  );

  /**
   * ⚠️ **A style on a heading is refused, not ignored.** The divider's own
   * vocabulary must not leak into a kind that cannot draw it.
   */
  it('refuses a divider style on a heading', () => {
    expect(
      displaySchemaFor(PresentationalKind.HEADING).safeParse({ style: 'dashed' }).success,
    ).toBe(false);
  });
});
