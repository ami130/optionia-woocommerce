import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

/**
 * Reject a string longer than `max` **bytes** in UTF-8.
 *
 * `@MaxLength` counts UTF-16 code units, which is the wrong unit whenever the
 * limit comes from a byte-oriented consumer. bcrypt is exactly that: it
 * truncates at 72 **bytes**, and an emoji is four of them — so a 60-character
 * passphrase of emoji is 120 bytes, passes `@MaxLength(72)`, and fails deeper.
 *
 * 🔴 **Measured before this existed**: registering with `"🎁" × 30` answered
 * `500 INTERNAL_ERROR`, because `assertUsablePassword()` threw past the DTO and
 * nothing mapped the throw to a status. A user with an emoji passphrase saw "An
 * unexpected error occurred" and had no way to learn why.
 *
 * Found by Phase 13 Stage 2's analysis, before the register form was written
 * against it — a form cannot attach a field error to a 500.
 */
export function MaxBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'maxBytes',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [max],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          // Only strings are measured. A non-string fails `@IsString` on its own,
          // and reporting it twice would show the user two messages for one fault.
          if (typeof value !== 'string') {
            return true;
          }

          return Buffer.byteLength(value, 'utf8') <= (args.constraints[0] as number);
        },

        defaultMessage(args: ValidationArguments): string {
          const bytes =
            typeof args.value === 'string' ? Buffer.byteLength(args.value, 'utf8') : 0;

          /*
           * The byte count is named because the character count is what the user
           * can see. "Too long" on a 60-character password that looks well under
           * a 72-character limit reads as a bug in the form.
           */
          return (
            `${args.property} must be at most ${args.constraints[0] as number} bytes ` +
            `(${bytes} given). Some characters, such as emoji, use several bytes each.`
          );
        },
      },
    });
  };
}
