import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * A boolean that means what the caller sent.
 *
 * 🔴 **`@IsBoolean()` alone does not reject a string, and the coercion inverts
 * the answer.** `main.ts` sets `enableImplicitConversion: true`, so
 * `class-transformer` casts the value *before* any validator sees it — and its
 * cast is JavaScript truthiness, under which **every non-empty string is
 * `true`**, the string `"false"` included.
 *
 * Measured against the live API before this existed:
 *
 * ```text
 * PATCH /v1/values/:id   {"isEnabled": "false"}  → 200, isEnabled: true
 * ```
 *
 * A merchant disabling an option value **enabled** it, with a success status and
 * nothing in the response to say so — and that value then appears on their
 * storefront. `"0"` and `"no"` behave the same way. Only `""` and numeric `0`
 * happen to read as false.
 *
 * ⚠️ **Why a transform rather than turning implicit conversion off.**
 * `enableImplicitConversion` is app-wide and every numeric and enum DTO relies
 * on it — query strings arrive as text, so removing it would break far more than
 * it fixed. This narrows the rule to the type that cannot survive the cast:
 * booleans are the one case where the coercion is not merely lax but produces
 * the **opposite** of what was sent.
 *
 * ## How it works, and the first attempt that did not
 *
 * ✏️ **Reading `value` is too late.** The obvious transform —
 * `({ value }) => typeof value === 'boolean' ? value : REJECTED` — compiled,
 * applied cleanly to all fifteen call sites, and **changed nothing**:
 * `enableImplicitConversion` casts during `plainToInstance`, so by the time a
 * `@Transform` sees `value` the string `"false"` has already become `true`.
 *
 * Proven rather than reasoned:
 *
 * ```text
 * plainToInstance(D, { flag: 'false' }, { enableImplicitConversion: true  }) → true
 * plainToInstance(D, { flag: 'false' }, { enableImplicitConversion: false }) → REJECTED
 * ```
 *
 * So this reads `obj[key]` — the **raw payload**, before any conversion — and
 * refuses anything that was not a boolean on the wire. The declared property
 * type stays `boolean`, so OpenAPI and the API contract still describe the field
 * honestly.
 *
 * The non-boolean is replaced with a sentinel object, which `@IsBoolean()` then
 * refuses. Returning the original would let the conversion re-apply; returning
 * `undefined` would read as "absent" and skip every validator on the property —
 * the same trap `NotNull` documents.
 *
 * 📌 **Absence still passes through untouched**, so `@IsOptional()` continues to
 * mean "omit to leave unchanged" on a patchable field.
 *
 * ## `null` is refused here, not left to the field
 *
 * 🔴 **`{"isEnabled": null}` was a 500.** `@IsOptional()` treats `null` and
 * `undefined` as the same absence, so it **skips every validator on the
 * property**; the `null` then reached a `NOT NULL` column and the database error
 * surfaced as `INTERNAL_ERROR`. Measured on a real option value, which reported
 * `500` and left the row unchanged.
 *
 * That is the failure `OptionalNotNull` exists for — and not one of the fourteen
 * optional booleans in this codebase had it. Rather than add a second decorator
 * to fourteen call sites and rely on the fifteenth being remembered, the rule
 * lives here: **every strict boolean refuses an explicit `null`**, whatever
 * optionality decorator sits beside it.
 *
 * ✏️ **It is the transform that achieves this, not a `ValidateIf`.** A
 * `ValidateIf((_o, value) => value !== undefined)` was written here first, on the
 * reasoning that it would override the neighbouring `@IsOptional()`. Mutation
 * testing showed it was **dead code**: removing it entirely changed nothing,
 * because the transform has already replaced a raw `null` with the sentinel by
 * the time any `ValidateIf` reads `value` — so `@IsOptional()` never sees a
 * `null` to excuse. The line was removed rather than kept with a false
 * explanation beside it.
 */
export function IsStrictBoolean(): PropertyDecorator {
  return applyDecorators(
    Transform(({ obj, key }) => {
      const raw: unknown = (obj as Record<string, unknown>)[key];

      if (raw === undefined) {
        return undefined;
      }

      // `null` becomes the sentinel too, so `@IsBoolean()` refuses it as a 400
      // rather than `@IsOptional()` waving it through to a NOT NULL column.
      return typeof raw === 'boolean' ? raw : REJECTED;
    }),
    IsBoolean(),
  );
}

/**
 * Stands in for a value that must not be coerced.
 *
 * An object rather than a string or a number: `@IsBoolean()` must refuse it, and
 * it must not itself be castable back into a boolean by anything downstream.
 */
const REJECTED = Object.freeze({ notABoolean: true });
