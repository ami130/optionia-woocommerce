import { Cardinality, Presentation, ValueKind } from '../../common/database/enums';
import { findType, isRegistered, registeredTypes } from './type-registry';

/**
 * The registry.
 *
 * M7.3 asks for `radio` only, built so **Phase 14 is registration, not
 * refactoring**. These tests are as much about that property as about radio: a
 * registry that happens to hold one entry and a registry that can hold twelve
 * look identical until someone adds the second.
 */
describe('type registry', () => {
  it('registers radio', () => {
    const radio = findType(Presentation.RADIO);

    expect(radio).not.toBeNull();
    expect(radio?.valueKind).toBe(ValueKind.CHOICE);
    expect(radio?.cardinality).toEqual([Cardinality.ONE]);
    expect(radio?.takesValues).toBe(true);
  });

  /**
   * Scope discipline, asserted rather than assumed. Phase 7 ships one type; a
   * second appearing here early is scope creep the milestone refuses.
   */
  it('registers exactly one type in Phase 7', () => {
    expect(registeredTypes()).toHaveLength(1);
  });

  /**
   * Null rather than a throw: an unregistered presentation is caller input, and
   * a throw would turn a typo in a request body into a 500.
   */
  it('returns null for a type that is not registered', () => {
    expect(findType(Presentation.DROPDOWN)).toBeNull();
    expect(findType('not-a-type')).toBeNull();
    expect(isRegistered(Presentation.CHECKBOX)).toBe(false);
  });

  /**
   * Every entry must carry all three schemas. A type registered without one
   * would validate nothing for that column while looking complete.
   */
  it('gives every registered type all three schemas', () => {
    registeredTypes().forEach((type) => {
      expect(type.validationSchema).toBeDefined();
      expect(type.displaySchema).toBeDefined();
      expect(type.pricingSchema).toBeDefined();
    });
  });

  /**
   * The registry keys on presentation because of the three-axis model (M5.4b):
   * radio and dropdown are the same choice/one pair rendered differently.
   */
  it('keys on presentation, and every key is a real presentation', () => {
    const valid = new Set<string>(Object.values(Presentation));

    registeredTypes().forEach((type) => {
      expect(valid.has(type.presentation)).toBe(true);
    });
  });

  describe('radio validation schema', () => {
    const radio = findType(Presentation.RADIO);

    it('accepts an empty object', () => {
      expect(radio?.validationSchema.safeParse({}).success).toBe(true);
    });

    it('accepts sane selection bounds', () => {
      expect(
        radio?.validationSchema.safeParse({ minSelections: 1, maxSelections: 1 }).success,
      ).toBe(true);
    });

    it('rejects a minimum above the maximum', () => {
      const result = radio?.validationSchema.safeParse({ minSelections: 3, maxSelections: 1 });

      expect(result?.success).toBe(false);
      expect(result?.error?.issues[0].message).toMatch(/exceeds the maximum/);
    });

    /**
     * Strict, so a typo is an error rather than a silently ignored field. A
     * merchant who writes `maxSelection` and sees it accepted will assume it
     * works.
     */
    it('rejects an unknown field rather than ignoring it', () => {
      const result = radio?.validationSchema.safeParse({ maxSelection: 2 });

      expect(result?.success).toBe(false);
    });
  });

  describe('radio display schema', () => {
    const radio = findType(Presentation.RADIO);

    it('accepts the documented options', () => {
      expect(
        radio?.displaySchema.safeParse({
          columns: 3,
          labelPlacement: 'above',
          showPriceDelta: true,
        }).success,
      ).toBe(true);
    });

    it('rejects an out-of-range column count', () => {
      expect(radio?.displaySchema.safeParse({ columns: 0 }).success).toBe(false);
      expect(radio?.displaySchema.safeParse({ columns: 99 }).success).toBe(false);
    });

    it('rejects an unknown label placement', () => {
      expect(radio?.displaySchema.safeParse({ labelPlacement: 'sideways' }).success).toBe(false);
    });
  });

  describe('radio pricing schema', () => {
    const radio = findType(Presentation.RADIO);

    /**
     * A radio prices per value. A type-level amount would be charged *in
     * addition* to the selected value's price, silently doubling every priced
     * option — so it is refused rather than accepted and ignored.
     */
    it('refuses type-level pricing', () => {
      expect(radio?.pricingSchema.safeParse({ type: 'fixed', amountMinor: 100 }).success).toBe(
        false,
      );
    });

    it('accepts null', () => {
      expect(radio?.pricingSchema.safeParse(null).success).toBe(true);
    });
  });
});
