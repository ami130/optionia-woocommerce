import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';

import { IsStrictBoolean } from './strict-boolean.decorator';

/**
 * A boolean that means what the caller sent.
 *
 * 🔴 **The defect this closes, measured against the live API before the fix:**
 *
 * ```text
 * PATCH /v1/values/:id   {"isEnabled": "false"}  → 200, isEnabled: true
 * ```
 *
 * A merchant disabling an option value **enabled** it, with a success status and
 * nothing in the response to say so — and that value then appears on their
 * storefront.
 */
class Dto {
  @IsOptional()
  @IsStrictBoolean()
  flag?: boolean;
}

/** Exactly how `main.ts` builds a DTO: implicit conversion on. */
const parse = (payload: Record<string, unknown>) => {
  const dto = plainToInstance(Dto, payload, { enableImplicitConversion: true });

  return { dto, errors: validateSync(dto as object) };
};

describe('IsStrictBoolean', () => {
  it.each([true, false])('accepts the real boolean %s', (value) => {
    const { dto, errors } = parse({ flag: value });

    expect(errors).toHaveLength(0);
    expect(dto.flag).toBe(value);
  });

  /**
   * 🔴 **`"false"` is the case that matters.** Under `enableImplicitConversion`
   * it casts by truthiness, so the string spelling of the opposite intent became
   * `true` — the caller got the reverse of what they asked for.
   */
  it.each(['false', '0', 'no', 'yes', 'true', ''])('refuses the string %p', (value) => {
    const { errors } = parse({ flag: value });

    expect(errors).toHaveLength(1);
  });

  /** A number is not a boolean either, however JavaScript feels about it. */
  it.each([0, 1, -1])('refuses the number %p', (value) => {
    const { errors } = parse({ flag: value });

    expect(errors).toHaveLength(1);
  });

  it.each([{}, [], { nested: true }])('refuses the object %p', (value) => {
    const { errors } = parse({ flag: value });

    expect(errors).toHaveLength(1);
  });

  /**
   * 📌 Absence must still mean "leave unchanged" on a patchable field — a
   * transform that returned a sentinel here would make every optional boolean
   * mandatory.
   */
  it('treats an omitted field as absent, not as invalid', () => {
    const { dto, errors } = parse({});

    expect(errors).toHaveLength(0);
    expect(dto.flag).toBeUndefined();
  });

  it('refuses an explicit null rather than silently skipping it', () => {
    const { errors } = parse({ flag: null });

    expect(errors).toHaveLength(1);
  });

  /**
   * ✏️ **The first attempt read `value` and changed nothing.**
   *
   * `enableImplicitConversion` casts during `plainToInstance`, so a `@Transform`
   * reading `value` sees `true` where the payload said `"false"`. This asserts
   * the raw payload is what decides — the property the fix turns on.
   */
  it('decides from the raw payload, not the converted value', () => {
    const { dto, errors } = parse({ flag: 'false' });

    expect(errors).toHaveLength(1);
    // Never silently the opposite of what was sent.
    expect(dto.flag).not.toBe(true);
  });
});
