import { plainToInstance } from 'class-transformer';
import { IsString, MaxLength, MinLength, validateSync } from 'class-validator';

import { OptionalNotNull, Trimmed } from './trimmed.decorator';

/** The exact decorator stack every patchable text field uses. */
class Patch {
  @OptionalNotNull()
  @Trimmed()
  @IsString()
  @MinLength(1, { message: 'A label cannot be empty.' })
  @MaxLength(200)
  label?: string;
}

const check = (body: Record<string, unknown>) => {
  const instance = plainToInstance(Patch, body);

  return { errors: validateSync(instance), value: instance.label };
};

describe('Trimmed', () => {
  /**
   * 🔴 **`@MinLength(1)` counts whitespace.**
   *
   * `"   "` has length 3, so every update route accepted it, and `buildPatch` —
   * which trims on the way to the database — then stored `''`. Measured on four
   * endpoints before this decorator existed.
   */
  it('refuses a whitespace-only value', () => {
    expect(check({ label: '   ' }).errors).toHaveLength(1);
  });

  it('trims before storing', () => {
    const { errors, value } = check({ label: '  Small  ' });

    expect(errors).toHaveLength(0);
    expect(value).toBe('Small');
  });

  it('leaves interior whitespace alone', () => {
    expect(check({ label: 'Extra  Large' }).value).toBe('Extra  Large');
  });
});

describe('OptionalNotNull', () => {
  /**
   * 🔴 **`@IsOptional()` treats `null` as absence**, so a null on a `NOT NULL`
   * column reached the database and returned a 500 rather than a 400.
   */
  it('refuses an explicit null', () => {
    expect(check({ label: null }).errors).toHaveLength(1);
  });

  /** `undefined` is a genuine absence and still belongs to `@IsOptional`. */
  it('allows the field to be omitted', () => {
    expect(check({}).errors).toHaveLength(0);
  });
});

/**
 * ✏️ **The regression that made this file necessary.**
 *
 * `NotNull` was written first as `ValidateIf(v => v === null)` + `@IsString()`.
 * A false `ValidateIf` skips *every* validator on the property, so with the
 * field absent or a plain string, `MinLength` and `MaxLength` stopped running —
 * a 201-character label and an empty string both validated. The decorator meant
 * to close one hole opened two wider ones, and only a probe of the whole stack
 * showed it.
 */
describe('the decorators compose rather than short-circuit', () => {
  it('still enforces the maximum', () => {
    expect(check({ label: 'x'.repeat(201) }).errors).toHaveLength(1);
  });

  it('still enforces the minimum', () => {
    expect(check({ label: '' }).errors).toHaveLength(1);
  });

  it('still accepts a valid value', () => {
    expect(check({ label: 'Small' }).errors).toHaveLength(0);
  });

  it('still enforces the type', () => {
    expect(check({ label: 42 }).errors).toHaveLength(1);
  });
});
