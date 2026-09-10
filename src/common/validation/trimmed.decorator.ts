import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

/**
 * Trim a string *before* validation runs.
 *
 * 🔴 **`@MinLength(1)` counts whitespace.** A label of `"   "` has length 3, so
 * every update route accepted it, and `buildPatch` — which trims on the way to
 * the database — then stored `''`. Measured on four endpoints: a value's label, a
 * group's label, an option's label and a set's name all became empty strings
 * through a validator whose whole purpose was to prevent that.
 *
 * The create paths were safe only because their services call `.trim()` by hand
 * before building the row, which is the same rule expressed in a second place —
 * and it reached only some of them.
 *
 * `class-validator` runs after `class-transformer`, so trimming here means every
 * length rule on the field measures what will actually be stored.
 *
 * ⚠️ **Non-strings pass through untouched.** A `null` on an optional field must
 * still reach `@IsOptional()`/`@IsString()` and be refused there rather than
 * throwing inside a transform — see `NotNull` for why `null` needs its own rule.
 */
export function Trimmed(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
}

/**
 * Optional, but **not** nullable.
 *
 * Use in place of `@IsOptional()` on a patchable field whose column is
 * `NOT NULL`: omitting the key leaves the value unchanged, and an explicit
 * `null` is refused at the edge.
 *
 * 🔴 **`@IsOptional()` treats `null` and `undefined` as the same absence**, so
 * `{"label": null}` skipped every validator on the field, reached a `NOT NULL`
 * column and surfaced as a **500 INTERNAL_ERROR**. Measured on four endpoints —
 * a set's name, a group's label, an option's label and an item's content. A 500
 * is wrong twice over: it tells a client the server broke when the request was
 * at fault, and it buries a database error in the log for something validation
 * should have caught.
 *
 * ✏️ **Two earlier attempts failed, and only a probe of the whole stack showed
 * it.** `ValidateIf(v => v === null)` plus `@IsString()` was silently
 * catastrophic — a false `ValidateIf` skips *every* validator on the property,
 * so a 201-character label and an empty string both became valid. A standalone
 * `registerDecorator` constraint never ran at all, because `@IsOptional()`
 * short-circuits first, which is precisely the behaviour being defeated.
 *
 * What works is replacing `@IsOptional()` rather than sitting beside it:
 * `ValidateIf` skips on `undefined` alone, so `null` falls through to the type
 * and length rules and is refused by `@IsString()`.
 *
 * ⚠️ **Only for `NOT NULL` columns.** A genuinely nullable one — `colorHex`,
 * `groupLabel`, `imageUrl` — must keep `@IsOptional()`, because `null` is how
 * the API clears it.
 */
export function OptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined);
}
